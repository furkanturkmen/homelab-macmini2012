import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesToPrepare, pruneRecord, liveKeys } from '../subtitles.mjs';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const empty = () => ({ ready: {}, failed: {} });
const sub = (Index, Codec, extra = {}) => ({ Type: 'Subtitle', Index, Codec, IsExternal: false, IsTextSubtitleStream: true, ...extra });
const episode = (Id, streams, Size = 1000) => ({
  Id, Name: `Episode ${Id}`, SeriesName: 'A Show',
  MediaSources: [{ Id: `src${Id}`, Size, MediaStreams: [{ Type: 'Video', Index: 0 }, ...streams] }],
});

test('asks for the first text track, in the format Jellyfin stores it as', () => {
  const [ass] = filesToPrepare([episode('a', [sub(2, 'ass'), sub(3, 'subrip')])], empty(), NOW);
  assert.equal(ass.path, '/Videos/a/srca/Subtitles/2/0/Stream.ass');
  const [srt] = filesToPrepare([episode('b', [sub(4, 'subrip')])], empty(), NOW);
  assert.equal(srt.path, '/Videos/b/srcb/Subtitles/4/0/Stream.srt');
  assert.equal(srt.name, 'A Show Episode b');
});

test('skips files with no built-in text subtitles', () => {
  const items = [
    episode('none', []),
    episode('external', [sub(2, 'subrip', { IsExternal: true })]),
    episode('image', [sub(2, 'PGSSUB', { IsTextSubtitleStream: false })]),
  ];
  assert.deepEqual(filesToPrepare(items, empty(), NOW), []);
});

test('done files are skipped, a replaced file (new size) is done again', () => {
  const record = empty();
  record.ready['a:srca:1000'] = '2026-11-17T00:00:00Z';
  assert.deepEqual(filesToPrepare([episode('a', [sub(2, 'ass')])], record, NOW), []);
  assert.equal(filesToPrepare([episode('a', [sub(2, 'ass')], 2000)], record, NOW).length, 1);
});

test('a failed file waits a day before it is tried again', () => {
  const record = empty();
  record.failed['a:srca:1000'] = { at: '2026-11-18T06:00:00Z', error: 'answered 500' };
  assert.deepEqual(filesToPrepare([episode('a', [sub(2, 'ass')])], record, NOW), []);
  record.failed['a:srca:1000'].at = '2026-11-17T06:00:00Z';
  assert.equal(filesToPrepare([episode('a', [sub(2, 'ass')])], record, NOW).length, 1);
});

test('keeps the library order (newest first)', () => {
  const out = filesToPrepare([episode('new', [sub(2, 'ass')]), episode('old', [sub(2, 'ass')])], empty(), NOW);
  assert.deepEqual(out.map(f => f.key), ['new:srcnew:1000', 'old:srcold:1000']);
});

test('forgets files that left the library', () => {
  const record = { ready: { 'a:srca:1000': 'x', 'gone:src:1': 'x' }, failed: { 'gone:src:2': { at: 'x' } } };
  const pruned = pruneRecord(record, liveKeys([episode('a', [])]));
  assert.deepEqual(pruned, { ready: { 'a:srca:1000': 'x' }, failed: {} });
});
