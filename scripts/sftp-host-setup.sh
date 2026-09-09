#!/usr/bin/env bash
#
# Turns a fresh Ubuntu machine into the pharmacy's remittance SFTP mailbox.
#
# Two accounts, both locked to one folder and to SFTP only (no shell, no port forwarding):
#   - a sender account for each company that pushes files (RedSail first), with a password,
#     because that is what their systems support; it can write into /inbox and nothing else;
#   - the site's own account, with the public key from data/sftp/pharmacy_ed25519.pub on the
#     pharmacy computer, which collects from /inbox and moves what it took to /inbox/done.
#
# Run as root on the host, once:
#   sudo bash sftp-host-setup.sh "<pharmacy public key line>" redsail "<password for redsail>"
#
# Add another sender later:
#   sudo bash sftp-host-setup.sh --sender caremark "<password>"
#
# Nothing here opens anything but port 22, and password logins are allowed only for the sender
# accounts; everyone else on the host still needs a key.
set -euo pipefail

ROOT=/srv/sftp/remits
GROUP=sftponly

ensure_base() {
  getent group "$GROUP" >/dev/null || groupadd "$GROUP"
  mkdir -p "$ROOT/inbox/done"
  # The chroot root must be owned by root and not group-writable, or sshd refuses it.
  chown root:root /srv/sftp "$ROOT"
  chmod 755 /srv/sftp "$ROOT"
  chown root:"$GROUP" "$ROOT/inbox" "$ROOT/inbox/done"
  chmod 2775 "$ROOT/inbox" "$ROOT/inbox/done"
  if ! grep -q "^# pharmacy-admin remits" /etc/ssh/sshd_config; then
    cat >> /etc/ssh/sshd_config <<EOF

# pharmacy-admin remits: SFTP-only accounts, locked to $ROOT
Match Group $GROUP
    ChrootDirectory $ROOT
    ForceCommand internal-sftp -u 0002
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
    PasswordAuthentication yes
EOF
  fi
}

add_sender() {
  local name="$1" password="$2"
  id "$name" >/dev/null 2>&1 || useradd -M -d / -s /usr/sbin/nologin -G "$GROUP" "$name"
  usermod -aG "$GROUP" "$name"
  echo "$name:$password" | chpasswd
  echo "sender account '$name' ready: it can write into /inbox"
}

add_site() {
  local pubkey="$1" name=pharmacy
  id "$name" >/dev/null 2>&1 || useradd -M -d / -s /usr/sbin/nologin -G "$GROUP" "$name"
  usermod -aG "$GROUP" "$name"
  mkdir -p "/etc/ssh/authorized_keys.d"
  echo "$pubkey" > "/etc/ssh/authorized_keys.d/$name"
  chmod 644 "/etc/ssh/authorized_keys.d/$name"
  # Keys outside the chroot, so the account's home need not exist inside it.
  grep -q "^AuthorizedKeysFile /etc/ssh/authorized_keys.d/%u" /etc/ssh/sshd_config || \
    sed -i '1i AuthorizedKeysFile /etc/ssh/authorized_keys.d/%u .ssh/authorized_keys' /etc/ssh/sshd_config
  echo "site account '$name' ready: it collects from /inbox with its key"
}

case "${1:-}" in
  --sender)
    ensure_base
    add_sender "$2" "$3"
    ;;
  *)
    [ $# -ge 3 ] || { echo "usage: $0 \"<site public key>\" <sender name> <sender password>   |   $0 --sender <name> <password>"; exit 1; }
    ensure_base
    add_site "$1"
    add_sender "$2" "$3"
    ;;
esac

sshd -t && systemctl reload ssh 2>/dev/null || systemctl reload sshd
echo "sshd reloaded. Host: $(hostname -I | awk '{print $1}')  port 22  folder /inbox"
