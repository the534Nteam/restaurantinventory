# Going live: Pepper Lunch Inventory

The Firebase project (`pepper-lunch-inventory`) is already connected in `index.html`.
These four steps put the app on a real web address and lock the database so only
phones with the store passcode can see or change anything. About 10 minutes, all
clicking, no code.

Do them in this order, in one sitting. Until step 3 is done the database is open
to anyone who finds it.

---

## Step 1: Turn on GitHub Pages (the web address)
1. Go to **github.com/the534Nteam/restaurantinventory** and click **Settings**.
2. Click **Pages** in the left menu.
3. Under **Branch**, pick **main**, leave the folder as **/ (root)**, and click **Save**.
4. After a minute or two, refresh. The page shows the link:
   **https://the534nteam.github.io/restaurantinventory/**

From now on, every change pushed to `main` goes live on that link by itself.

## Step 2: Turn on anonymous sign-in
1. Go to **https://console.firebase.google.com** and open **pepper-lunch-inventory**.
2. Left menu: **Build > Authentication**. If it asks, click **Get started**.
3. Open the **Sign-in method** tab, click **Anonymous**, switch it **on**, and **Save**.
4. Open the **Settings** tab > **Authorized domains** > **Add domain** and add
   `the534nteam.github.io`.

Staff never see a login. Each phone gets an invisible ID that the database uses
to remember it entered the passcode.

## Step 3: Publish the security rules
1. Left menu: **Build > Firestore Database**, then the **Rules** tab.
2. Delete everything in the box.
3. Open `firestore.rules` in this repo on GitHub, click the copy button, and paste
   it into the box.
4. Click **Publish**.

## Step 4: Set the store passcode
1. Right after publishing, open the app link yourself.
2. It asks you to **choose a store passcode**. Use 6 or more digits. 8 is better.
   The first passcode entered becomes the store passcode, which is why you do this
   right away.
3. Give staff the link and the passcode. Each phone enters it once.

To change the passcode later: **Setup > Cloud sync > Change passcode**. Every
other phone gets signed out and asks for the new one. Do this when someone leaves.

## Put it on each phone's home screen
* **iPhone:** open the link in Safari, tap **Share**, then **Add to Home Screen**.
* **Android:** open the link in Chrome, tap the **⋮** menu, then **Add to Home screen**
  (or **Install app**).

It opens full screen with the PL icon, like a regular app.

---

## How the data is stored
* `stores/_index`: the list of store locations.
* `stores/loc_<id>`: one location's vendors, items, pars, counts and daily sales.
* `stores/loc_<id>/history/...`: one document per saved inventory. Older versions kept
  every saved inventory inside the location record, which would have hit Firestore's
  1 MB limit after roughly 80 saves. The app moves old saves over by itself the first
  time it opens.
* `members/<phone id>`: phones that entered the passcode.
* `settings/passcode`: the passcode. The rules block anyone from reading it.

Setup changes go up one field at a time, and only the fields that changed, so two
people editing different settings at once don't overwrite each other. Counts and
daily sales go up one item or one day at a time.

## Troubleshooting
* **Header says "Synced (unsecured)":** step 2 or step 3 isn't done yet.
* **Header says "Sync error" after step 2:** check that `the534nteam.github.io` is in
  Authorized domains. If the API key has website restrictions in Google Cloud
  console, add `https://the534nteam.github.io/*` there too.
* **Locked out of every phone:** in Firebase console > Firestore > Data, delete the
  `settings` collection. The next person to open the app picks a new passcode.
