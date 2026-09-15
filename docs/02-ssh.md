# Phase 2 — Connect from your Windows PC (SSH)

You're done with the monitor and keyboard on the Mac Mini. Everything from here is done remotely.

## Step 2.1 — SSH into the Mac Mini

On your Windows PC, open **PowerShell** (press Windows key, type "powershell", Enter).

Type:

```
ssh yourusername@192.168.1.42
```

Replace `yourusername` with the username you picked and `192.168.1.42` with the actual IP.

First time only, it asks:

```
Are you sure you want to continue connecting (yes/no)?
```

Type `yes`, Enter. Then enter your password. You're now controlling the Mac Mini from your Windows PC. Any command you type happens on the Mac Mini.

## Step 2.2 — Unplug the Mac Mini's monitor and keyboard

You don't need them anymore. The Mac Mini can live in a closet with just power and Ethernet.

---

[← Phase 1: Install Ubuntu on the Mac Mini](01-install-ubuntu.md) · [All phases](README.md) · [Phase 3: Install Docker →](03-docker.md)
