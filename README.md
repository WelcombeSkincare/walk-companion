# Walk Companion (beta)

A web app for walk leaders and walkers that uses the phone's GPS to show the notes for the stop you are approaching. It works offline once saved, runs in Chrome on Android, and installs to the home screen like an app.

## What it does

- Follows your position along the route and shows the next stop's talking point, with a buzz and a chime when you arrive.
- Reads talking points aloud, on demand or automatically.
- Shows the route, all points of interest and your position on an OS Outdoor map.
- Shows distance and time to the next stop, and whether you are ahead of or behind the day plan.
- Has two views. Leader view adds background notes, the day plan and leader notes. Walker view shows the talking points and map only.
- Has a practice mode to step through the walk at home.
- Supports more than one route. Each route is one JSON file in `routes/`.

## Setting up (once)

1. **OS map key.** Create a free account at [OS Data Hub](https://osdatahub.os.uk/) on the OpenData plan. Create a project, add the **OS Maps API** to it, and copy the project API key. Paste it into Settings on each phone (the published code holds no key). The app uses the free Outdoor style at zoom levels 7 to 16. **Without a key** the app falls back to the free OpenStreetMap map: it needs signal, and keeps only the areas you have viewed, because the OpenStreetMap tile policy does not allow bulk downloading. To prepare it for offline, open the Map tab at home and zoom in along the whole route. With a key, a layer button on the map switches between the OS map and OpenStreetMap.
2. **Hosting.** Publish this folder on any HTTPS static host, such as GitHub Pages or Netlify. GPS and offline saving only work over HTTPS.

## Before each walk (on Wi-Fi)

1. Open the link in Chrome on the phone.
2. Chrome menu (⋮) → **Add to Home screen** (or **Install app**).
3. Open the app, go to **Settings**, check the OS key, and tap **Save walk and map for offline**. Wait for "All set".
4. Optional: go to **Now** → **Practice mode** and drag the slider to rehearse the stops.

Send walkers the same link with `?view=walker` on the end, for example `https://example.org/walk-companion/?view=walker`. That opens the walker view and hides the leader notes.

## On the day

- Tap **Start GPS** at the start, and allow location.
- **Keep the screen on.** Chrome on Android pauses GPS when the screen is off or the app is in the background, so arrivals are only detected while the app is on screen. Turn on **Keep screen on while walking** in Settings, lower the brightness, and carry a power bank. Expect roughly 15 to 25% battery an hour with the screen on.
- **Previous** and **Next** browse stops by hand. **Follow GPS** returns to automatic.
- On the walk day the schedule uses the clock. On any other day, tap **Plan → Set walk start time to now** at the real start.

## Adding a route

Each route is a JSON file in `routes/` with an entry in `routes/index.json`. The file holds the track, the stops (with name, position, km along the route, talking point and background HTML), the stages, the day plan and the leader notes. Routes for this app are prepared from an OS Maps link and a researched guide.

## Known limitations (beta)

- No GPS tracking with the screen off (see above).
- OS Premium mapping (1:25,000 Leisure style) is not included. It needs a Premium plan and a different map projection.
- Reading aloud uses the phone's built-in voices. Most Android phones have an offline English voice, but check in practice mode at home with Wi-Fi off.
- The OS API terms on storing map tiles on a device have not been checked in detail. The app saves only the few hundred tiles covering the walk.

Map data: Contains OS data © Crown copyright and database rights. Map library: Leaflet (BSD-2-Clause).
