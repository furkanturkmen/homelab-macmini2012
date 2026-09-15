#!/bin/sh
# Reboot after a kernel crash instead of hanging. Run once: sudo sh reboot-on-crash.sh
#
# Written after the crash of 2026-09-15: the kernel oopsed, kdump saved a crash
# dump and then hung for 35 minutes waiting for the USB data disk, so the Mac
# Mini answered ping and nothing else, and the house had no DNS. The crash log
# is also kept by systemd-pstore, so kdump is not needed for that.
set -u
[ "$(id -u)" = 0 ] || { echo "Run it with sudo:  sudo sh $0"; exit 1; }

echo "== a. reboot 10 seconds after a kernel crash"
cat > /etc/sysctl.d/90-reboot-on-crash.conf <<'EOF'
# From homelab-scripts/reboot-on-crash.sh (2026-09-15).
# A kernel crash or lockup reboots after 10 seconds instead of hanging.
kernel.panic = 10
kernel.panic_on_oops = 1
kernel.softlockup_panic = 1
EOF
sysctl -p /etc/sysctl.d/90-reboot-on-crash.conf

echo
echo "== b. remove kdump (it hung instead of rebooting)"
systemctl disable --now kdump-tools >/dev/null 2>&1 || true
if dpkg -s kdump-tools >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get purge -y kdump-tools >/dev/null 2>&1 \
    && echo "kdump-tools removed" || echo "WARNING: could not remove kdump-tools"
  update-grub >/dev/null 2>&1 && echo "boot menu updated" || echo "WARNING: update-grub failed"
else
  echo "kdump-tools was already removed"
fi
if grep -qs crashkernel /etc/default/grub /etc/default/grub.d/*; then
  echo "WARNING: crashkernel is still in the boot config"
else
  echo "the 512 MB crash-kernel reservation is gone after the next reboot"
fi

echo
echo "== c. test the hardware watchdog (nothing permanent)"
if modprobe iTCO_wdt 2>/dev/null; then
  sleep 1
  ls -l /dev/watchdog* 2>/dev/null || echo "driver loaded, but no /dev/watchdog"
else
  echo "the watchdog driver did not load"
fi
dmesg | grep -i -E "iTCO" | tail -3

echo
echo "== done - send the output to Claude"
