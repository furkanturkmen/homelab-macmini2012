# Phase 0 — Check the drive first (optional, but do it now if at all)

Most Late 2012 Mac Minis shipped with a **5400 rpm 2.5" hard drive**. If yours still has one, swap it for an SSD *before* you install Ubuntu. Doing it afterwards means reinstalling everything from scratch.

An SSD is the single biggest speed difference you can make on this machine — far more than RAM or CPU. Container startup, Nextcloud, the *arr apps and the Jellyfin library scan are all limited by random reads that a spinning disk is bad at.

**Already have an SSD?** If the machine already runs Linux, check with:

```bash
lsblk -d -o NAME,MODEL,SIZE,ROTA
```

`ROTA=0` means solid state — skip this phase. `ROTA=1` means it is a spinning disk. On macOS: **About This Mac → System Report → Storage**, look at "Medium Type".

## What to buy

- **2.5" SATA SSD**, 500 GB or 1 TB. Crucial MX500 or Samsung 870 EVO are the safe picks.
- **T6 Torx screwdriver** — internal screws
- **T8 Torx screwdriver** — drive bracket
- **Plastic spudger or an old credit card** — to pop the case open

The Mac Mini's port is SATA III (6 Gb/s), so any modern 2.5" SATA SSD runs at full speed. There is no NVMe slot on this model — that arrived with the 2014 Mac Mini.

## Doing the swap

- Power the Mac Mini off and unplug it
- Follow the iFixit guide: search **"Mac Mini Late 2012 Hard Drive Replacement"**
- Budget 30–45 minutes if you are careful. The bottom cover twists off — no glue, no adhesive
- While the machine is open, this is also the moment to replace the CPU thermal paste if you ever plan to

Then continue with [Phase 1](01-install-ubuntu.md) as normal.

---

[All phases](README.md) · [Phase 1: Install Ubuntu on the Mac Mini →](01-install-ubuntu.md)
