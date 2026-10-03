# Game Points

A mobile-first web app for tracking points during a physical-card game. Cards stay in
your hands — the app only tracks bets, the pot, whose turn it is, and each player's balance.

Static build, hostable on GitHub Pages.

## Setup

### 1. Firebase

The database must be **Cloud Firestore in Native mode** — Datastore mode is not supported by the
web SDK (every write fails with `FAILED_PRECONDITION` and the client retries forever).

1. Create a project at <https://console.firebase.google.com>.
2. **Authentication → Sign-in method → Email/Password** → Enable.
3. **Authentication → Users → Add user** is not needed — players sign up in the app.
4. **Firestore Database → Create database** → **Start in production mode**, region `nam5` (or the one
   closest to you). Confirm the header says *Cloud Firestore*, not *Datastore mode*.
5. **Project settings → Your apps → Web app (`</>`)** → register an app → copy the config.
6. Copy `.env.example` to `.env` and paste the values:

```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project
VITE_FIREBASE_STORAGE_BUCKET=your-project.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
# Comma-separated usernames allowed to add points to other accounts (optional —
# you can also hardcode them in src/lib/admins.ts).
VITE_ADMIN_USERNAMES=yourname
```

7. **Security rules** — `firestore.rules` is committed to this repo. Publish it with the Firebase
   CLI from the project root. Note that `users/{username}` allows **any signed-in player to update**
   a profile: settling a pot, topping someone up or an admin funding an account all write the
   affected players' profiles from whichever client drove the action. Only `create`/`delete` are
   restricted to the owner, so nobody can squat a name. Anyone signed in can also write
   `tables/{code}` — this is a friends app, not a hostile-multiplayer one.

```bash
firebase deploy --only firestore:rules --project <your-project>
```

Or paste the same contents into **Firestore → Rules** in the console:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{username} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
                    && request.auth.token.email == username + '@teenpatti.local';
      allow update: if request.auth != null;
      allow delete: if request.auth != null
                    && request.auth.token.email == username + '@teenpatti.local';
    }
    match /tables/{code} {
      allow read: if request.auth != null;
      allow write: if request.auth != null;
    }
  }
}
```

### 2. Run

```bash
npm install
npm run dev
```

### 3. Test

```bash
npm test          # game rules + points accounting
npm run build     # typecheck + production build into dist/
```

## Deploy to GitHub Pages

Push to GitHub, then in the repo:

1. **Settings → Pages → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions → New repository secret** — add all six
   `VITE_FIREBASE_*` values from your `.env`.

The workflow in `.github/workflows/deploy.yml` typechecks, runs the tests, builds, and deploys.

## How a game runs

1. **Sign up** with a username (3–20 chars: `a-z`, `0-9`, `_`) and a password (min 6 characters).
   New accounts start at **0 points** — a balance is just your running won-minus-lost.
2. **Create a table** → you get a **6-digit code**, and others **Join** with that code. Sitting
   down never credits points: every account starts at **0** and an admin adds points to it from
   the dashboard. Nobody can play until they're above the table's floor.
3. Admin presses **Start game** → a **5 second countdown** that plays **READY → 3 → 2 → 1 → ROUND
   START** over the felt → cards fly out to every seat **one pass at a time, three passes each**, and
   the **boot / dabba** (default 10) from every eligible player drops into the centre.
4. Play passes around the circle. **You always sit at the bottom of the felt** and everyone else
   wraps around from your **left to your right** — each player sees the same thing from their own
   seat. The centre shows the **dabba** (pot value and a chip stack), **whose turn** it is, the
   **round**, the **point level**, the **minimum**, and how many players are **seen**.
5. **Ending a round takes two steps.** The admin (or, heads-up, the player on turn) presses
   **End round…** and confirms → the table moves to **ROUND ENDED** and betting stops. Then the
   winner is named on a separate **Select winner** panel, and only then does the pot move. Heads-up
   **Show** does both at once, since a show already decides the winner.
6. When a round settles there's a **10 second wait**, then the next round **starts automatically**.

Every table also carries a status pill in the header — `WAITING`, `RUNNING`, `ROUND ENDED`,
`WINNER SELECTED` or `COMPLETED` — derived from the phase so it can never drift out of sync.

### Betting rules

- **Blind (hidden)** is the default. Press **See my cards** once you've looked at your hand — you
  stay *seen* for the rest of the round.
- **Seen players put in 2×** a blind bet; **blind players put in half** of a seen bet. The minimum
  is never below the current point level.
- The **+/−** buttons step by the point level. You cannot chaal below the minimum or above your chips.
- When your turn starts an **action sheet pops up** with all of it — **Close** it and the dock at the
  bottom of the screen stays available.
- If you can't cover the minimum, you can only **Leave game** (fold).
- **Round** increments when the turn returns to whoever started the round. After every **3 rounds**
  the point level **doubles automatically** and never comes back down.
- **After your third blind chaal you are flipped to SEEN automatically** — no button to press, and
  everyone sees the badge flip on the table.
- **Blind play has a table-wide deadline too.** Once **Blind closes after N rounds** betting rounds
  have passed (default 3) nobody may stay hidden: every remaining BLIND player becomes SEEN and the
  whole table gets an **ALL PLAYERS ARE NOW SEEN** banner. The admin can change N in the config.

### Joining mid-round

Anyone can join while a round is in play — they take a seat and **sit out until the next round**,
then play normally. Because they joined through the code, the **admin gets a seat picker**: choose
which spot they should take. Seats are locked while a round runs and unlock again at round end.
If you ignore it nobody is blocked — they simply keep the seat the table gave them.

### Side show & show

- **Side show** — only when **3+ players** are left and the admin has it enabled. You challenge the
  previous player; pick who lost, and they fold.
- **Show** — appears only when **exactly 2 players** remain. Pick who won and the pot settles in one
  step, because a show already decides it.
- **End round…** — the admin (or, heads-up, whoever is on turn) stops play first and names the
  winner second. Between those two steps the table is in **ROUND ENDED**: no more bets, no timer,
  and only the admin or whoever stopped it may pick.

### Admin controls

Open the **Admin** panel from the table header:

- **Pause** — freezes every timer and blocks bets, shows and sideshows until you **Resume**.
  Pending countdowns are shifted forward by however long you were paused.
- **Give points** — hand points straight to any seated player's balance, mid-game if you like.
  Use it when someone drops below the floor and is about to sit out.
- **Table config** — starting amount, boot / dabba, base point, double-every-N-rounds,
  blind-closes-after-N-rounds, max players, side show on/off, and who sees the **chips** and
  **config**. Locked while a round is in play. Changing config restarts the 10-second wait.
- **Stop the table** — first shows a **full summary** of every player's current balance and their
  net at this table; only after you confirm does the table actually close for everyone. A round in
  progress is abandoned and nobody scores.
- **Arrange seats** — in the lobby, every row has **↑ ↓** buttons that swap a player with the
  neighbour above or below. This sets the order play travels around the table, so set it before you
  start. The same list is available between rounds under **Arrange seats for the next round**.
  Seats are locked while a round is in play.
- **Place mid-game joiners** — a player who joins with the code mid-round raises a **Place** banner
  and pops a grid of open seats. Tap an open spot to send them there, or tap an occupied one to swap.
- Remove players in the lobby. If the admin leaves, **the next seated player becomes admin**.

### The 30-point floor

To take a seat in a round a player needs **boot + 2 × base point** on their account (10 + 2×10 = 30
by default). Below that they are marked **sitting out** for that round — no boot, no chips. Top them
up during the 10-second wait and they play; if the timer runs out first, they sit it out and play
the next one.

### Funding accounts

Nobody earns points just by turning up. Every account starts at **0**, joining a table credits
nothing, and creating a table credits nothing — the only way a balance grows outside a round is an
admin adding points.

If your username is in `src/lib/admins.ts` (or `VITE_ADMIN_USERNAMES`), your dashboard shows an
**Add points to a player** card: type a username or tap one of the people you share tables with,
enter the amount, and their balance goes up immediately. The card also tells you how many points
you've added in total.

### Points & history

Points are funded from the dashboard, never by joining a table. Each round hands out chips
(separate from your balance) and the table settles by **delta only**, so every round is
**zero-sum**. Your dashboard tracks **balance, games, wins, losses, points played, total won, total
lost, points added by an admin**, plus a per-game history (last 100 games) with the table, pot,
headcount and your +/- for that round.

### Round history

The table document keeps two ledgers alongside the live game state, so nothing is reconstructed
from client memory:

- **`roundHistory`** — the last 20 finished rounds: round number, start/end time, pot, winner, and
  one line per player with their seat, blind chaals, whether they folded and their delta.
- **`actionHistory`** — the last 150 individual movements: a monotonic sequence number, the round,
  who acted, whether it was `boot` / `blind` / `seen` / `fold` / `sideshow` / `saw`, the amount, and
  the dabba total afterwards.

Both live inside `tables/{code}` rather than in subcollections on purpose: a chaal has to update the
chips, the pot, the turn *and* the history in one atomic write, and Firestore cannot span collections
in a single transaction. The table page exposes them under **Round history** and **Chaal ledger**.

### Animations

Every animation is a *consequence* of a snapshot the backend already committed — none of them feed
state back into the game, and a rejected transaction never plays a success animation.

- **Chaal** — a `−₹N` chip leaves the seat, the dabba flashes `+₹N` and an impact ring pulses out of
  the centre; the pot number and chip stack update from the authoritative value.
- **Dealing** — three passes of card backs fly from the deck to each seat, after the boot chips land.
- **Round start** — `READY → 3 → 2 → 1 → ROUND START` is drawn purely from the countdown deadline.
- **Turn** — the active avatar pulses and the action sheet opens once per turn.
- **Blind → SEEN** — the seat badge flips on its axis the moment the engine changes it.
- **Winner** — the table dims, a trophy drops in with the winner, the final dabba and every player's
  delta; tap anywhere to dismiss, or it clears itself after six seconds.
- All of it is `position: absolute` so nothing reflows, and `prefers-reduced-motion` shortens every
  animation to a 0.12s fade.

### Insights

A stopped table stays listed on the dashboard for its **admin only** — open it to see the
scoreboard: every player who sat, their **games played, wins, losses and net points**, plus the
round count.

## Project layout

```
src/
  lib/
    types.ts     shared types, config, status mapping, history + limits
    firebase.ts  Firebase init
    auth.ts      username/password auth + profile creation
    engine.ts    pure game rules (betting, blind limits, turns, rounds, timers, pause/close)
    store.ts     Firestore transactions + balance/history effects
  pages/
    LoginPage.tsx      sign in / sign up
    DashboardPage.tsx  balance, stats, your tables, create/join, history
    TablePage.tsx      circular felt (you always sit at the bottom), hub, action dock, sheets
    InsightsPage.tsx   read-only scoreboard for a stopped table
  styles.css
scripts/
  engine.test.ts   166 assertions on game rules
  store.test.ts    36 assertions on points accounting
firebase.json          Firebase CLI project config
firestore.rules        security rules (published by firebase deploy)
firestore.indexes.json index config (no composite indexes needed yet)
```

The engine is pure — `applyAction(table, action, balances?)` returns a new table plus side effects,
with no Firestore calls. The store reads the seated players' balances when the rules need them, runs
everything inside one transaction, and applies balance, stats and history updates together. That's
what keeps the points consistent even when two players act at the same moment.

Timers have no server: the table stores a countdown deadline, and whichever client sees it expire
first fires the transition. The transaction is what makes exactly one of them win.
