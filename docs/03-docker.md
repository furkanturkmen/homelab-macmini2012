# Phase 3 — Install Docker

Docker is what runs all your services in their little boxes.

## Step 3.1 — Update Ubuntu

Still in the SSH session:

```
sudo apt update && sudo apt upgrade -y
```

`sudo` means "run as admin" — it asks for your password the first time. `apt` is Ubuntu's app store, run from the command line. This updates all installed system software. Takes a few minutes.

## Step 3.2 — Install Docker

```
curl -fsSL https://get.docker.com | sh
```

This downloads the official Docker install script and runs it. Takes a couple minutes.

## Step 3.3 — Let your user run Docker without `sudo`

```
sudo usermod -aG docker $USER
```

Then **log out and back in** (type `exit`, then SSH again) so this takes effect.

Test it works:

```
docker run hello-world
```

You should see a friendly message. If yes, Docker is installed correctly.

---

[← Phase 2: Connect from your Windows PC (SSH)](02-ssh.md) · [All phases](README.md) · [Phase 4: Deploy the homelab stack →](04-deploy-the-stack.md)
