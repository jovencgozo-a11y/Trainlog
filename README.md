# Trainlog

A single-file, offline-first strength and running log that runs entirely in the browser.

`index.html` is the whole app — markup, styles, and logic in one document. There is no
build step and no server: open the file, or serve the directory statically, and it works.

## Running it

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

A static host works too, since the app is just the one file.

## What's in it

Five tabs — Today, Plan, Mobility, Progress, Build — covering program generation,
per-session set logging with effort ratings, estimated 1RM and progression tracking,
run plans and paces, readiness check-ins, and mobility/PT routines.

- **Storage.** All data lives in the browser under the `trainlog-data-v3` localStorage key.
  Nothing is sent anywhere. Clearing site data clears the log, so use the in-app backup
  export to move between devices or browsers.
- **Design tokens.** The Nocturne token set at the top of the file is the source of truth
  for the look; retune the custom properties there rather than patching component rules.
- **Network.** Nothing is uploaded — there is no telemetry, account, or backend. The only
  outbound requests are the Inter and Barlow Condensed webfonts from Google Fonts and the
  Three.js modules resolved by the importmap, plus a YouTube search opened in a new tab
  when you tap an exercise's form link. All of it degrades offline: fonts fall back to
  system UI and the 3D body map falls back to the flat map.

## Progression engine

The performance-based progression is the core of the app, so it is worth stating what the
rules actually are:

- **Loaded lifts** ratchet on logged performance (`loadRec`). A session counts as clean when
  the top set makes the week's rep target and every working set lands within one rep of it.
  Beginners progress after one clean session, intermediates after two *at the same weight*.
  One short session holds the load; two consecutive trigger a 10% reduction.
- **How hard it felt** is an optional tap. When it is skipped the effort is inferred from the
  reps — beating the top of the range by two or more counts as easy and progresses; merely
  finishing is provisional and asks for one extra clean session before the bar moves. Silence
  never reads as a full green light.
- **Timed holds** take their duration from the movement's own pattern — a wall sit is not a
  Copenhagen plank — scaled by the week's adaptation and shortened on a deload.
- **Bodyweight work** climbs on reps to the top of the goal's range, then steps up to a harder
  variation and rebuilds. Two sessions short of target step back down to an easier one.
- **Load steps** scale with the lift (roughly 2.5–10%, floored at one 2.5 lb increment) and are
  capped at 110% of the recent best so a mis-logged rep cannot spike the weight.
- **Readiness** trims sets *and* the load: a "pull back" day seeds 7.5% lighter, a technique day
  15%. Those sessions are marked, and the ratchet neither rewards nor punishes them.
- **1RM estimates** use Epley with reps capped at 10, the range the formula is valid over, so a
  high-rep burnout set can confirm a max but never inflate one.

Progression history reads the archive as well as the current block, so earned weight survives
a program rebuild.

## In-session muscle map

The workout screen pins a small 3D figure beside the current movement, lit to the muscle groups
that movement trains. The two buttons on it move it to the other side of the screen and hide it;
hidden, a **Muscles** chip brings it back. Both choices persist. The figure is mounted once per
session and re-lit as you move between movements, so the whole session costs one WebGL context.

## Managing the week

On the **Today** tab, drag a session from one day of the week strip onto another to move it;
dropping it on a day that already has a session swaps the two. A mostly-vertical gesture is
left to the page so the screen still scrolls, and a plain tap still opens that day.


The generated schedule is a starting point. **Plan → Manage schedule** changes two separate
things: which weekday each session lands on (tap a day; if it is taken, the two sessions swap),
and the order Trainlog works through sessions, which is what it offers you next when you finish
one. Editing either leaves everything logged untouched, and "Reset to suggested" puts the
generated week back.

## Notes on this snapshot

This is the v191 preview build with the progression-audit fixes applied. Two things in it
are preview scaffolding rather than shipping behavior:

- The final `<script>` seeds a demo program and a few sample sessions on first load when
  no plan exists yet, so the preview opens onto a populated app instead of an empty one.
  Remove it for a build that should start from the real onboarding flow.
- Service worker registration near the end of the file is gated behind `if(false && ...)`,
  so the app does not currently install one. Enabling it also requires an `sw.js` next to
  `index.html`, which this repository does not yet contain.

The 3D body map uses `./muscles.glb` (BodyParts3D, © DBCLS, CC BY-SA 2.1 Japan) whenever that
file sits next to `index.html`. The model is not committed here, so if it is missing the view
falls back to a schematic figure built from primitives in `buildBody()` and says so on screen —
drop `muscles.glb` in and the anatomical model comes straight back, no code change. Either way
it needs three.js, which loads from jsDelivr on first open and is cached after; with no
connection at all the card falls back to the flat anatomical map as before.
