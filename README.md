# Building Architect

A dark-mode editor for sketching building structure (walls, rooms, floors) at the HouseKit's
scale and exporting exact dimensions for the UE 5.7 / Blender side.

## Run it (Windows)

1. Install Node.js 20 or newer from https://nodejs.org (LTS).
2. Open a terminal in this folder and run:
   ```
   npm install
   npm run dev
   ```
3. Open http://localhost:5173 in Chrome or Edge (needed for Save to write straight to a file).

## Kit defaults

| Setting | Value |
| --- | --- |
| Scale | 1 Blender unit = 1 m = 100 Unreal units |
| Wall module | 2 m (default snap) |
| Fine grid | 0.125 m (hold Shift) |
| Story height | 3 m (2.5 m preset for the PQ cottage) |
| Wall thickness | 0.25 m |
| Texture density | 32 px/m |

All of these are editable in the Kit panel and saved with each project.

## Using it

| Key | Action |
| --- | --- |
| R | Room tool: drag a rectangle |
| W | Wall tool: click corner to corner; Esc, right-click or double-click stops |
| D / N / A | Door / window / arch: click a wall node for a default size, or drag node to node along a wall |
| S | Stair area: drag in the direction you climb; rises to the floor above and cuts a void there. Pick straight, mid landing, L or U turn in the inspector |
| F | Roof: drag the footprint (centrelines); pick gable, hip, shed, gambrel or flat in the inspector |
| O | Floor opening: drag a hole in this floor (stair well, double-height void, hatch); drag its corner squares to resize |
| C | Chimney: click to drop a 0.75 × 0.75 m stack, or drag its size |
| [ / ] | Rotate the selected roofs, stairs or chimneys 15° (Shift for 1°) |
| V | Select: click, Shift-click to add, drag empty space to box-select, drag to move |
| Shift / Alt | Fine 0.125 m snap / no snap |
| J | Merge selected walls that meet end to end in a straight line |
| H | Hide / show selected walls, openings, stairs or roofs |
| Ctrl+G | Group the selection (any mix of items, across floors) |
| 1–6 | Plan, Front, Back, Left, Right, 3D views (Tab toggles plan / 3D) |
| L | Blueprint library |
| Del | Delete selection |
| Ctrl+Z, Ctrl+Shift+Z | Undo, redo |
| Ctrl+A | Select everything on the floor |
| Ctrl+S, Ctrl+O, Ctrl+E | Save, open, export |
| Mouse wheel, right/middle drag | Zoom, pan |

- **Rooms** appear when walls close a loop, named "Room N" and tagged `f1-rN`. Walls are tagged `f1-wN`,
  doors `f1-dN`, windows `f1-winN`, stairs `f1-sN`.
- **Openings** snap to 0.125 m nodes along the wall. Select one to type its width, height, sill and its
  distance from either end, or drag it to slide along the wall.
- **Elevations** (Front/Back/Left/Right) are drawn from the model with openings cut through, floor
  levels, overall width and height to the top. Click anything in them to select it.
- **Centre**: the orange crosshair is the middle of the ground floor, shown on every floor and view
  (dashed axis in elevations, orange line in 3D). "Centre building on origin" moves the whole
  building so that point sits on 0,0.
- **Roofs** are made of pieces (slopes, hips, gable ends, parapets). Each can be hidden from the
  inspector; hidden pieces stay in the export flagged `hidden: true`.
- **Stairs** come in four shapes: one straight flight, straight with a mid landing, L (quarter turn
  at a corner landing) and U (half turn at a full-width landing, flights side by side). Set which way
  it turns, the flight width, landing depth and how many risers come before the landing; the
  inspector shows each flight's risers, tread and width and warns when it gets steep. Rotate a stair
  with its round knob, [ ] or the inspector. The export lists each flight, the landing, the walking
  line and every tread block's outline.
- **Floor openings**: every stair cuts its own opening in the floor above, sized to the stair plus a
  0.15 m margin all round (change the margin in the stair's inspector), and it follows the stair as
  you move, resize or rotate it. Drag the opening's corner squares, move it or type a size and it
  stays as you set it ("Fit to stair again" brings it back). Use the Floor opening tool (O) for any
  other void. Rooms show their area net of openings; the export lists `floorOpenings` per floor.
- **Rotating roofs**: select a roof and drag the round knob above it (15° steps, Shift for 1°, Alt
  free), type an angle, or use the ±15° / ±90° buttons. A house can have as many roofs as you like.
  "Roof over selection" lines the new roof up with the walls you selected, even when they are not
  square to the grid.
- **Overlapping roofs trim each other**: where one roof runs into another (a cross gable, a wing, a
  porch against a wall), each is cut back to where they meet, so you get proper valleys instead of
  roofs passing through each other. The inspector lists what cut a roof and how much of each piece
  is left. Untick "Cut where other roofs and chimneys run into it" to keep a roof whole. The export
  keeps the full piece (`vertices`) and the cut result (`trimmed`).
- **Chimneys** start on a floor and rise through the roofs, which are cut around them. The auto top
  follows the 3-2-10 rule (0.9 m above where it leaves the roof, and 0.6 m above any roof within
  3 m), or set a fixed top. Tagged `f1-chN`; exported with their outline, base, top and crown.
- **Library**: every structure you work on is saved in the browser automatically, with plan and front
  thumbnails. Duplicate, rename, export or import files from there. The library lives in this
  browser's storage, so use Export (or Save) to keep copies on disk.

## Files

- `*.bpa.json`: the project (Save / Open). Autosave in the browser covers crashes only.
- `*.export.json`: the handoff (Export). Includes walls with their openings, rooms, stairs (steps,
  riser, tread), roof pieces as 3D polygons, groups, the building centre and hidden flags. Metres plus a `uu` block in Unreal units
  (X = plan x, Y = -plan y, Z up). Wall start/end are centrelines; room `interior` and `clear`
  are measured to inside wall faces.

## Development

```
npm test        # geometry and export tests
npm run build   # type-check and production build
```

Stack: React + TypeScript + Vite, Three.js via React Three Fiber, Zustand.
