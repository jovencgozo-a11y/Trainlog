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

## Notes on this snapshot

This is the v191 preview build, committed verbatim. Two things in it are preview
scaffolding rather than shipping behavior:

- The final `<script>` seeds a demo program and a few sample sessions on first load when
  no plan exists yet, so the preview opens onto a populated app instead of an empty one.
  Remove it for a build that should start from the real onboarding flow.
- Service worker registration near the end of the file is gated behind `if(false && ...)`,
  so the app does not currently install one. Enabling it also requires an `sw.js` next to
  `index.html`, which this repository does not yet contain.

The 3D body map fetches `./muscles.glb` (BodyParts3D, © DBCLS, CC BY-SA 2.1 Japan), which
is also not in this repository. Both the inline card and the full-screen viewer catch the
failure and fall back to the flat anatomical map, so the app works without it — drop the
model next to `index.html` to turn the 3D view on.
