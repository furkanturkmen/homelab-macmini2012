# Phase 1 — Install Ubuntu on the Mac Mini

This wipes the Mac Mini completely and installs Ubuntu Linux.

## Step 1.1 — Download the Ubuntu installer

On your Windows PC:

- Go to https://ubuntu.com/download/server
- Click the green **"Download Ubuntu Server 26.04 LTS"** button
- You get a file ending in `.iso`. It's about 2.6 GB. Save it to your Downloads folder.

An `.iso` file is a complete copy of an installer disc. You'll write it to the USB stick next.

## Step 1.2 — Write the ISO to your USB stick

- Go to https://rufus.ie and download **Rufus** (a free tool for making bootable USB sticks)
- Plug your USB stick into your Windows PC
- Open Rufus
- **Device:** pick your USB stick from the dropdown (double-check — the wrong one erases the wrong drive!)
- **Boot selection:** click "SELECT" and choose the Ubuntu `.iso` you just downloaded
- **Partition scheme:** GPT
- **Target system:** UEFI
- Leave everything else at defaults
- Click **START**. If it asks about "ISO or DD mode," pick **ISO mode**. If it warns "all data will be destroyed," click OK.
- Wait 5-10 minutes for it to finish

Your USB stick is now a bootable Ubuntu installer.

## Step 1.3 — Boot the Mac Mini from the USB

- Plug the following into the Mac Mini:
  - HDMI cable → monitor
  - USB keyboard (wired)
  - Ethernet cable → your router
  - The USB stick you just made
  - Power cable
- Turn on the Mac Mini and **immediately hold the `Option` (⌥) key** on the keyboard
- Keep holding until you see a screen with boot options (Apple's boot picker)
- You should see the USB stick as a yellow "EFI Boot" icon. Use arrow keys to select it, press Enter.

If nothing happens or the Mac Mini boots into macOS anyway: unplug the USB, power off, try again with the Option key held from the exact moment you press power.

> ⚠️ **Ethernet must be plugged in before boot.** The Mac Mini 2012's Broadcom BCM4331 wifi chip has no in-installer driver — booting without Ethernet triggers a kernel panic as the installer tries to init the network. Do not skip the cable.

## Step 1.4 — Install Ubuntu

The Ubuntu installer starts. It's mostly menus. Press Enter to accept defaults unless noted:

- **Language:** English
- **Keyboard layout:** pick yours (US, UK, etc.)
- **Type of install:** Ubuntu Server (not "minimized")
- **Additional options / Search for third-party drivers:** ✅ **Yes** — this is a scan step, not a guaranteed install. On the Mac Mini 2012 the installer typically reports *"No applicable third-party drivers are available locally or online"* — that's expected and fine. The Broadcom BCM4331 wifi driver is *not* in this DB; it's a regular apt package (`bcmwl-kernel-source`) you can install later only if you want wifi. Since Ethernet is required anyway, most users never need it.
- **Network:** should auto-detect your Ethernet and show a DHCP-assigned IP (e.g. `192.168.1.42/24`). **Change nothing** — just select Done. Do not try to set a static IP here; static assignment is done at the router in Step 1.6 (cleaner and survives OS reinstalls). **Write down the IP and MAC address shown now** — you'll need both for the router reservation later.
- **Proxy:** leave blank
- **Mirror:** leave default
- **Storage:** pick "Use an entire disk" and select the Mac Mini's internal drive. Leave "Set up this disk as an LVM group" ✅ **checked**. Leave "Encrypt LVM with LUKS" ❌ **unchecked** (headless server = no monitor for boot password on every reboot). **THIS ERASES THE MAC MINI COMPLETELY.**
- **⚠️ Fix the LVM root size before continuing.** Ubuntu's default LVM layout only allocates ~100 GB to the root volume (`ubuntu-lv`) even if your disk is 500 GB — leaving ~370 GB stranded in the volume group. Docker + Nextcloud + Jellyfin will fill 100 GB fast. Fix now: in the FILE SYSTEM SUMMARY, arrow down to `ubuntu-lv` under USED DEVICES → Enter → **Edit** → clear the Size field or set it to the max shown (e.g. `473G`) → **Save**. Confirm the `/` mount now shows the full disk size. Then **Done**.
- **Confirm the destructive action:** yes, continue
- **Profile setup:**
  - Your name: your name
  - Server's name (hostname): `homelab` (this is what shows up on your network)
  - Username: pick a short lowercase name, no spaces (e.g. `furkan`)
  - Password: strong, but memorable — you'll type it a lot
- **Ubuntu Pro:** pick "Skip for now". Free for personal use (5 machines, 10-year security patches), but signup mid-install breaks flow. Attach later with `sudo pro attach <token>`.
- **SSH setup:** ✅ **Check "Install OpenSSH server"** — this is critical, you need it to log in remotely. Also click **Import SSH identity → from GitHub** and enter your GitHub username — your public keys get added to `~/.ssh/authorized_keys` so you can SSH in without a password. Leave "Allow password authentication over SSH" ✅ checked as fallback until you've confirmed key login works. (Public keys are public — literally at `github.com/<username>.keys` — nothing sensitive.)
- **Featured server snaps:** don't check anything. Skip. Especially do NOT check `nextcloud` — the snap would conflict with the docker-compose Nextcloud you'll run later.
- Wait for install to finish (10-20 minutes)
- When it says "Install complete!", pick **Reboot Now**
- When it says "Please remove the installation medium," pull out the USB stick and press Enter

Ubuntu boots for the first time. You see a login prompt like:

```
homelab login: _
```

Type your username, Enter, type your password (nothing shows as you type — normal), Enter. You're in.

## Step 1.5 — Find the Mac Mini's IP address

At the login prompt (after logging in), type:

```
ip a
```

Look for a section starting with `enp` or `eth` (the Ethernet connection). Find the line with `inet 192.168.x.x` or `inet 10.x.x.x`. That number is the Mac Mini's IP address on your network. **Write it down.** Example: `192.168.1.42`.

## Step 1.6 — Reserve the IP address in your router

If you don't do this, your Mac Mini's IP could change tomorrow and everything breaks.

- Open a browser on your phone/laptop
- Go to your router's admin page (usually `http://192.168.1.1` or `http://192.168.0.1` — check the sticker on the router)
- Log in (default password often on the sticker too)
- Find a section called "DHCP Reservation," "Static Leases," "Address Reservation," or similar
- Add a reservation for the Mac Mini's MAC address (also shown by `ip a` next to `link/ether`) → assign it its current IP forever

Now the Mac Mini always has the same IP.

---

[← Phase 0: Check the drive first (optional, but do it now if at all)](00-ssd.md) · [All phases](README.md) · [Phase 2: Connect from your Windows PC (SSH) →](02-ssh.md)
