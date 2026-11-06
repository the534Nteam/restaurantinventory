# Pepper Lunch Inventory

The counting and ordering app for Pepper Lunch Moanalua. This page lists where
every piece lives.

## The app
**https://pepperlunch-inventory.netlify.app**

This is the one link staff use. Save it to each phone's home screen (Safari: Share >
Add to Home Screen; Chrome: ⋮ > Add to Home screen). Each phone enters the store
passcode once.

## How it fits together
| Piece | Where | What it does |
|---|---|---|
| Code | GitHub: `the534Nteam/restaurantinventory`, branch `main` | The one copy of the app. Everything else comes from here. |
| Website | Netlify site `pepperlunch-inventory` | Rebuilds from GitHub `main` on every change. Nothing to upload by hand. |
| Data | Firebase project `pepper-lunch-inventory` (Firestore) | Counts, pars, saved inventories and sales, shared live by every phone. Locked by `firestore.rules` and the store passcode. |
| Par basis | [Build-to par report, Oct 2026](https://pepper-lunch-moanalua-build-to-pars-for-k4r5.pages.grok.bot/) | Where the Tue / Thu / Fri pars came from (R365 purchases, Sept 1 to Oct 28). Also linked in the app under Setup. |

## Changing things
* **Pars:** in the app, on the 🎯 Pars tab. Saves right away for every phone.
* **Items, vendors, staff names, recipients:** in the app, on the ⚙️ Setup tab.
* **Passcode:** Setup > Cloud sync > Change passcode. Every other phone has to
  enter the new one. Change it when someone leaves.
* **How the app works:** edit `index.html` and push to `main`. Netlify publishes it
  within a minute or two.

## Files
* `index.html`: the whole app.
* `firestore.rules`: the database lock. If it changes, paste it into Firebase console >
  Firestore Database > Rules and click Publish.
* `CLOUD-SYNC-SETUP.md`: how the database and passcode are set up, and what to do if
  something goes wrong.
* `manifest.json` and the icons: let phones install it like an app.
* `tests/`: checks for the database lock (run with the Firebase emulator).
* `build-artifact.sh`: makes an offline copy for a claude.ai artifact. That copy
  doesn't sync, so staff should not use it.
