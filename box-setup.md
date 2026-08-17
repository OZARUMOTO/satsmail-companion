# Sats Mail companion — box setup

Reconstructable deployment record for the box that serves the Sats Mail sync
QR. LAN IPs are shown as placeholders — read the real values from the box
(`hostname -I`, `systemctl cat satsmail-companion`) when rebuilding.

## Layout (on the box)

```
~/satsmail-companion/
├── sync-qr.js        # companion: queries bwt, renders animated QR, serves page
├── ur-bytes.js       # bytewords-Minimal UR encoder (fountain systematic parts)
└── xpub.txt          # the satsmail account xpub — NEVER commit this file
```

## systemd unit — `satsmail-companion`

```ini
[Unit]
Description=Sats Mail sync QR companion
After=network.target

[Service]
User=mikegotbtc
WorkingDirectory=/home/mikegotbtc/satsmail-companion
Environment=PORT=8082
Environment=BROADCAST_BASE=http://$BOX_IP:8082/broadcast
EnvironmentFile=/home/mikegotbtc/satsmail-companion/xpub.env   # SATMAIL_XPUB=...
ExecStart=/usr/bin/node sync-qr.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- `PORT` — HTTP port the page + broadcast endpoint serve on (8082).
- `BROADCAST_BASE` — base URL for the "broadcast" page the device's done-screen
  QRs point at (`$BOX_IP/broadcast`).
- `SATMAIL_XPUB` — the account xpub, in `xpub.env` (or `xpub.txt` read by the
  script). Keep the xpub out of version control.

## Firewall (UFW)

Default deny incoming; allow SSH + the companion + bwt ports from the LAN
subnets (adjust subnets to your network):

```bash
sudo ufw allow from $LAN_SUBNET_1 to any port 22
sudo ufw allow from $LAN_SUBNET_1 to any port 8082 proto tcp
sudo ufw allow from $LAN_SUBNET_1 to any port 8081 proto tcp   # companion fallback
sudo ufw allow from $LAN_SUBNET_1 to any port 50001 proto tcp  # bwt electrum (local)
sudo ufw allow from $LAN_SUBNET_2 to any port 8082 proto tcp   # second NIC, if present
```

## bwt (forked, taproot-capable)

- Source: `github.com/OZARUMOTO/bwt` (fork with `tr(...)` descriptor support).
- Registers taproot wallets as `-x <xpub>:tr` descriptors.
- Electrum server on `127.0.0.1:50001`; HTTP API on `127.0.0.1:3060`.
- Logs to `~/bwt.log`; restart after config changes (`sudo systemctl restart bwt`).

## Deploy / update the companion

```bash
scp sync-qr.js ur-bytes.js mikegotbtc@$BOX_IP:~/satsmail-companion/
ssh mikegotbtc@$BOX_IP 'sudo systemctl restart satsmail-companion'
curl -s $BOX_IP:8082 | head -5        # sanity: page + "frame 1 / N" + balance line
```

## How it works (short version)

`sync-qr.js` queries bwt for the satsmail xpub's BIP-86 taproot scripthashes,
builds the sync payload (same schema as the app's `sync.rs`), and serves an
animated **bytewords-Minimal UR** QR (`ur:bytes/<seq>-<count>/<bytewords>` with
a CRC32 per part) at `http://$BOX_IP:8082`. The page pre-renders frames
server-side (data-URL images), polls `/frames` every 5 s, and the companion
re-syncs bwt every 30 s. `/broadcast` + `/pushtx` serve the compose-send
broadcast page.

## Rebuild checklist (box died)

1. Install node + `npm i qrcode bitcoinjs-lib tiny-secp256k1` (see `sync-qr.js` requires)
2. Restore bwt fork + systemd unit + UFW rules (above)
3. Restore `xpub.txt` / `xpub.env` (from the device: Sats Mail → Compose → export xpub)
4. `sudo systemctl enable --now satsmail-companion bwt`
5. Open `http://$BOX_IP:8082` on a phone, scan from the Prime (Sats Mail → > send → sync from qr)
