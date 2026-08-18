# Sats Mail — sideload bundle (v0.3.17)

A retro 2009 email client that happens to be a Bitcoin wallet — **taproot only
(BIP-86)**. Sideloadable on Passport Prime 1.4.0 — **no cable, no computer,
no airlock**: everything runs through the camera.

## Files

| File | What it is |
|---|---|
| `satsmail.app` | The install archive (5.0 MiB, v0.3.17, **signed with the OZARUMOTO publisher key**, md5 `81f914f1ea6ec5f8a93e7306ed98ba5a`). Copy to the SD/USB-C drive → Settings → Apps → Install App. **Allow the OZARUMOTO publisher on the Prime first** (`foundation cert install OZARUMOTO`, fingerprint in the app repo's `PUBLISHER.md`). |
| `sync-qr.js` + `ur-bytes.js` | The companion: runs on the box where bwt lives, renders the inbox as an animated QR for the Prime to scan. |

**Box service** — `satsmail-companion` runs `sync-qr.js` from
`~/satsmail-companion` on the box, on **port 8082** (`PORT=8082`;
`BROADCAST_BASE=http://$BOX_IP:8082/broadcast`). It reads the wallet
xpub from `~/satsmail-companion/xpub.txt` (or `SATMAIL_XPUB` env). UFW must
allow 8082 from the LAN — see `box-setup.md` for the exact subnets.

## Install

1. Copy `satsmail.app` to the SD card / USB-C drive.

## ⚡ Pair the box first (v0.3.16+)

Since v0.3.16 every sync QR is **HMAC-authenticated**. The box holds a
32-byte secret (`~/satsmail-companion/pairing-secret`, 0600); the Prime
stores the same secret after one scan:

1. On the box: **redeploy `sync-qr.js`** (this bundle) and restart the
   `satsmail-companion` service — it generates the secret on first start.
2. Open `http://$BOX_IP:8082/pair` on your phone.
3. On the Prime: Sats Mail → inbox → **"pair with box"** → scan that QR once.
4. Done — the inbox footer shows `pairing: paired`. From now on **any sync
   QR that isn't signed by that secret is rejected** ("auth failed — sync qr
   is not from your box"), so a fake page on the phone can't feed you a fake
   balance.

Re-pairing (scanning `/pair` again) **rotates** the secret — the old one
stops working. Tap the pairing footer on the inbox to **unpair** (sync then
blocks until you re-pair).

## Changelog

- **v0.3.17** — **paranoid send** (all QR, no new deps):
  - **type-the-amount-twice** — the compose preview's "sign & send" button
    stays locked until you re-type the exact amount (Coldcard-style).
  - **change-address proof** — the compose preview shows the change output
    and its derivation path (`m/86'/0'/0'/1/<n>`), matched against the
    device's internal keychain on-device (or "none — exact spend").
  - **broadcast-receipt loop** — after the box broadcasts, it shows a receipt
    QR (`satsmail-receipt:<status>:<txid>`, `/receipt` page). The done
    screen now shows the expected txid (computed on-device from the signed
    tx) + a **verify broadcast** button: scan the receipt and the Prime
    compares txids — a lying box can't fake a hash of the tx the Prime
    itself signed. The receipt QR upgrades from mempool → confirmed as
    confirmations arrive.
- **v0.3.16** — **paranoid sync**: added HMAC-SHA256 authentication to the
  QR sync channel. The box signs every payload with a pairing secret
  (`/pair` page, stored in `~/satsmail-companion/pairing-secret`); the Prime
  verifies after a one-time "pair with box" scan and refuses anything that
  doesn't match (bad tag, missing tag, or replayed/stale payloads). Secret
  lives in the app's encrypted AppData. HMAC is hand-rolled on `sha2` and
  verified against the RFC 4231 vectors; the canonical JSON re-serialization
  is unit-tested byte-identical to the companion's signing input.
- **v0.3.15** — new launcher icon: a bitcoin-orange envelope glyph (replaces
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
- **> send → compose send** — scan a plain address QR → type amount + fee →
  on-device build preview showing the **change address + derivation path** →
  **re-type the amount to unlock sign** → signed-tx QR out. After the box
  broadcasts, **verify broadcast** scans the box's receipt QR and checks the
  txid against the one the Prime computed — the send loop closes with proof,
  not vibes.
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

- **v0.3.15** — new launcher icon: a bitcoin-orange envelope glyph (replaces
  the SDK template's teal diamond slab). The old icon was a full-canvas
  background that rendered as a square over the launcher's round badge;
  the new one is a 110×110 transparent-glyph icon per the SDK 1.0.0 icon
  rules (8-point transparency check passed). `icon.bin` dropped from
  48,456 → 15,864 bytes. **Reboot the Prime after sideloading** — the
  launcher caches the tile per app-id and only refreshes on reboot.
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
