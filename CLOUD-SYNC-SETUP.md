# Cloud Sync Setup (Firebase) — Pepper Lunch Inventory

The app already has all the sync code built in. It runs **offline** until you paste your
Firebase project keys into `index.html`. Once configured and hosted, every phone/computer
opening the link shares one live inventory **per store location**.

Total time: ~15 minutes. No coding required — just copy/paste.

---

## Step 1 — Create a free Firebase project
1. Go to **https://console.firebase.google.com** and sign in with a Google account.
2. Click **Add project** → name it e.g. `pepper-lunch-inventory` → Continue.
3. Google Analytics: **not needed** — turn it off → Create project.

## Step 2 — Create the database
1. In the left menu: **Build → Firestore Database** → **Create database**.
2. Location: pick the closest region (for Hawaii, `us-west1` or `nam5`). 
3. Start in **Production mode** → Enable.
4. Open the **Rules** tab, replace everything with this, then **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /stores/{doc=**} {
      allow read, write: if true;
    }
  }
}
```
> Note: these rules let anyone with the link read/write. The app's **store passcode**
> keeps casual users out. If you want stronger security later, I can add anonymous
> sign-in so only the app can touch the data — just ask.

## Step 3 — Get your web config
1. Click the **gear icon → Project settings**.
2. Scroll to **Your apps** → click the **`</>`** (Web) icon.
3. Nickname it `inventory` → **Register app** (skip Hosting for now).
4. It shows a `const firebaseConfig = { ... }` block. **Copy those 6 values.**

## Step 4 — Put the config in the app
Open `index.html` and find this near the top of the script (search for `FIREBASE_CONFIG`):

```js
const FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};
```
Paste your values between the quotes. **Or just send me the 6 values and I'll paste them in.**

## Step 5 — Host the file (free)
The synced app must live at a real web address (the claude.ai preview link can't run sync).
Easiest option — **Netlify Drop** (no account, no CLI):
1. Go to **https://app.netlify.com/drop**
2. Drag `index.html` onto the page.
3. It gives you a URL like `https://random-name.netlify.app` — that's your app.
   (Rename it in Site settings if you like.)

Alternatives: **Firebase Hosting** (you already have the project), **GitHub Pages**,
or **Cloudflare Pages**. Any static host works.

## Step 6 — Set the store passcode
1. Open your hosted app → pick **Moanalua** → your name → a day → **⚙️ Setup**.
2. Under **Cloud sync**, type a **Store passcode** (e.g. `1234`).
3. Share the hosted link + passcode with staff. Each device enters it once.

## Done
Everyone on the link now shares the same live inventory for each location. Counts,
pars, history, and suggestions all sync in real time and keep working offline
(catching up when the phone reconnects).

To add a second store later: Setup → Store locations → Add. Each store keeps its own
shared data automatically.
