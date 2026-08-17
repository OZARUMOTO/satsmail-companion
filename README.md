# Sats Mail — sideload bundle (v0.3.14)

A retro 2009 email client that happens to be a Bitcoin wallet — **taproot only
(BIP-86)**. Sideloadable on Passport Prime 1.4.0 — **no cable, no computer,
no airlock**: everything runs through the camera.

## Files

| File | What it is |
|---|---|
| `satsmail.app` | The install archive (3.7 MiB, v0.3.14, **signed with the OZARUMOTO publisher key**). Copy to the SD/USB-C drive → Settings → Apps → Install App. **Allow the OZARUMOTO publisher on the Prime first** (`foundation cert install OZARUMOTO`, fingerprint in the app repo's `PUBLISHER.md`). |
| `sync-qr.js` + `ur-bytes.js` | The companion: runs on the box where bwt lives, renders the inbox as an animated QR for the Prime to scan. |

**Box service** — `satsmail-companion` runs `sync-qr.js` from
`~/satsmail-companion` on the box, on **port 8082** (`PORT=8082`;
`BROADCAST_BASE=http://$BOX_IP:8082/broadcast`). It reads the wallet
xpub from `~/satsmail-companion/xpub.txt` (or `SATMAIL_XPUB` env). UFW must
allow 8082 from the LAN — see `box-setup.md` for the exact subnets.

## Install

1. Copy `satsmail.app` to the SD card / USB-C drive.
2. Insert into the Prime → **Settings → Apps → Install App** → pick it.
3. Launch Sats Mail. On first launch it asks for **seed access** (the
   app-scoped seed, `device-secrets.app-scoped-seed`) — **approve the
   prompt** (or pre-allow under Settings → Apps → Sats Mail). The app retries
   every 2 s until you do.

## What works on the Prime (no crash, all QR)

- **Compose** — receive address derived on-device from the app-scoped seed
  (**BIP-86 taproot, `bc1p…`**, account 0). Tap "new address" for the next
  index.
- **> send** — scan a PSBT from the phone → verified against your key →
  preview → sign on-device (key-path taproot) → animated signed-PSBT QR out
  for the phone to broadcast. Fully offline.
- **sync from qr** (inbox) — scan the companion's animated QR → inbox +
  balance update. No electrum, no cable.
- **account xpub** — shown on Compose; the box's bwt must track this for the
  companion to see satsmail's funds.
- **export xpub to airlock** (Compose, under the xpub) — saves
  `satsmail-xpub.txt` to the USB share. **Important: the airlock is only
  writable while the Prime is UNPLUGGED** (while plugged in, the computer
  locks the volume and the device unmounts it). Flow: unplug the Prime →
  export → plug it back in → grab `satsmail-xpub.txt` from the AIRLOCK
  drive. First tap prompts for the airlock permission
  (`file-system.airlock-files`, grantOnFirstUse) — approve it under
  Settings → Apps → Sats Mail → Permissions, or at the prompt.

**Taproot only, on purpose:** satsmail tracks exactly one script type (BIP-86).
Anything on satsmail's old BIP-84 addresses is intentionally not tracked —
satsmail was set up fresh, so there is nothing to orphan.

## The companion (box side)

```bash
cd ~/satsmail-companion        # on the box; deps already installed
SATMAIL_XPUB=<xpub from Sats Mail → Compose> node sync-qr.js
```

It queries bwt (127.0.0.1:50001) for that xpub's **BIP-86 taproot** scripts
(derivation verified against the official BIP-86 test vector), builds the sync
payload (same schema as `sync.rs`), and serves an animated UR2 `bytes` QR at
`http://<box-ip>:8082`. Open it on your phone → point the Prime at it.

The QR frames are **pre-rendered server-side** into data-URL images (the old
page called `QRCode.toCanvas` in the browser where `QRCode` was never defined
→ black screen). The page polls `/frames` every 5 s, so balance/mails refresh
without a reload; the companion re-syncs bwt every 30 s.

**QR format (fixed):** frames are **bytewords-Minimal** UR parts — `ur:bytes/<seq>-<count>/<bytewords>` with a CRC32 checksum per part — exactly what the device's scanner (foundation_ur) requires. Earlier attempts used raw hex, which fails the scanner's `bytewords::validate` (the "bad sync qr" / "Bytewords error" you saw). The message is a CBOR byte string wrapping the JSON payload, and the fountain parts are systematic (seq 1..=N = raw fragments), so no xoshiro implementation is needed. Verified: every served frame decodes with a real QR reader, CRC32 validates, and the payload reassembles byte-for-byte.

**Gotcha (fixed):** `payments.p2tr().output` is a `Uint8Array` — calling
`.toString('hex')` on it returns comma-joined decimals, not hex, which silently
produced wrong scripthashes (balance always 0). Copy it into a `Buffer` first:
`Buffer.from(p2tr.output).toString('hex')`.

Notes:
- **Satsmail's wallet is its own** — it derives from the app-scoped seed, NOT
  the built-in wallet's seed. The built-in wallet/Envoy will never see
  satsmail's balance, and vice versa — this stays true even though both are
  now taproot (different derivations: app-seed BIP-86 vs. device-seed BIP-86).
- **bwt**: the forked bwt on the box accepts `-x <xpub>:tr` for taproot
  wallets (Envoy's and satsmail's are both registered this way). The QR-sync
  companion doesn't need any bwt config — it queries scripthashes directly.
- bwt is a full-indexing Electrum server, so it answers scripthash queries for
  any xpub — no second bwt instance needed for the QR flow.
- Electrum is deliberately disabled on the device (the Prime has no network);
  the app surfaces `electrum: offline` instead of crashing.

## Changelog

- **v0.3.14** — switched signing identity from the SDK's `KeyOS` dev cert to
  the **OZARUMOTO publisher cert** (`signing-identity = "OZARUMOTO"` in
  `app-config.toml`; the stale `cosign2.toml` secret path was fixed to the
  macOS home dir). No app code changes. See `PUBLISHER.md` in the app repo for
  the publisher fingerprint used in the allow step.
- **v0.3.13** — fixed a crash when scanning an address QR on the Compose/send
  tab (`RefCell already borrowed` — the code called `state.borrow()` inside its
  own `borrow_mut()`; the utxos are now cloned before the mutable borrow).

## Build (for when you change it)

```bash
cd ~/sdk-apps/satsmail
nix develop ~/.foundation/sdk/current -c foundation pack -r   # → target/keyos/satsmail.app
```
