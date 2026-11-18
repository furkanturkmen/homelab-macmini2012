import { test } from 'node:test';
import assert from 'node:assert/strict';
import { englishSubs, assGroups, groupRegex, pickReplacement, stuckSwaps } from '../anime-subs.mjs';

const sub = (Codec, Language, extra = {}) => ({ Type: 'Subtitle', Codec, Language, IsExternal: false, ...extra });

test('English ASS, English other, or none', () => {
  assert.equal(englishSubs([sub('ass', 'eng'), sub('subrip', 'eng')]), 'ass');
  assert.equal(englishSubs([sub('subrip', 'eng')]), 'other');
  assert.equal(englishSubs([sub('webvtt', 'en')]), 'other');
  assert.equal(englishSubs([sub('ass', 'fre')]), 'none');           // French ASS is not English
  assert.equal(englishSubs([sub('ass', 'eng', { IsExternal: true })]), 'none'); // sidecars say nothing about the release
  assert.equal(englishSubs([]), 'none');
});

test('a group is preferred after enough files, mostly with English ASS', () => {
  const groups = {
    'Erai-raws': { ass: 81, other: 0, none: 0 },
    VARYG: { ass: 51, other: 3, none: 0 },
    'Anime Time': { ass: 3, other: 220, none: 0 },
    'Tsundere-Raws': { ass: 23, other: 0, none: 12 },
    Rare: { ass: 2, other: 0, none: 0 },
  };
  assert.deepEqual(assGroups(groups), ['Erai-raws', 'VARYG']);
});

test('group names are matched whole and literally', () => {
  const re = new RegExp(groupRegex(['SubsPlus+', 'Erai-raws']), 'i');
  assert.ok(re.test('SubsPlus+'));
  assert.ok(!re.test('SubsPlus'));
  assert.ok(!re.test('Erai-raws2'));
});

const release = (over) => ({
  title: 't', guid: 'g', indexerId: 1, releaseGroup: 'Erai-raws', protocol: 'torrent', seeders: 10,
  quality: { quality: { resolution: 1080 } }, customFormatScore: 15, mappedEpisodeNumbers: [1, 2, 3, 4],
  rejections: ['Existing file on disk meets quality cutoff: 1080p'], ...over,
});
const current = { resolution: 1080, episodes: [1, 2, 3, 4], group: 'BlueLobster' };

test('swaps to a preferred group that covers the episodes', () => {
  assert.equal(pickReplacement([release()], current, ['Erai-raws']).releaseGroup, 'Erai-raws');
});

test('never swaps to something Sonarr refuses for another reason, or worse, or dead', () => {
  const groups = ['Erai-raws'];
  assert.equal(pickReplacement([release({ rejections: ['Bluray-1080p Remux is not wanted in profile'] })], current, groups), null);
  assert.equal(pickReplacement([release({ quality: { quality: { resolution: 720 } } })], current, groups), null);
  assert.equal(pickReplacement([release({ seeders: 0 })], current, groups), null);
  assert.equal(pickReplacement([release({ mappedEpisodeNumbers: [1, 2] })], current, groups), null);
  assert.equal(pickReplacement([release({ releaseGroup: 'Unknown' })], current, groups), null);
  assert.equal(pickReplacement([release({ releaseGroup: 'BlueLobster' })], current, ['BlueLobster']), null);
});

test('prefers what Sonarr scores higher, then more seeders', () => {
  const picked = pickReplacement([
    release({ guid: 'hevc', customFormatScore: -20, seeders: 100 }),
    release({ guid: 'x264-few', seeders: 3 }),
    release({ guid: 'x264-many', seeders: 30 }),
  ], current, ['Erai-raws']);
  assert.equal(picked.guid, 'x264-many');
});

test('only our own swaps that Sonarr holds back are imported by hand', () => {
  const swaps = { '87:1': { downloadId: 'ABC', result: 'grabbed' } };
  const queue = [
    { downloadId: 'abc', trackedDownloadState: 'importBlocked' },
    { downloadId: 'abc', trackedDownloadState: 'downloading' },
    { downloadId: 'other', trackedDownloadState: 'importBlocked' },
  ];
  assert.equal(stuckSwaps(queue, swaps).length, 1);
});
