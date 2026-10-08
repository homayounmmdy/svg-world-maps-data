# svg-world-maps-data

Map data files for the [`svg-world-maps`](https://www.npmjs.com/package/svg-world-maps) package.

This repository contains the raw SVG map data files that power the 
`svg-world-maps` library. It exists separately so that users of the 
main package can fetch only the specific maps they need, keeping 
install sizes minimal.

## Installation

You don't install this repository directly. Instead, use the 
`svg-world-maps` package and its CLI:

```bash
npm install svg-world-maps
npx add-map usa
```

The `add-map` command downloads the requested map file from this 
repository via jsDelivr CDN.

## Usage

After running `npx add-map <name>`, import the map in your code:

```javascript
import { registerMapData, createMap } from 'svg-world-maps';
import usaData from './src/maps/usa';

registerMapData('usa', usaData);

const map = createMap('usa');
```

## Available Maps

Browse the [`maps/`](./maps) directory to see all available map files.

Map file names are lowercase and case-sensitive. For example:

- `usa.ts`
- `europe.ts`
- `brazil.ts`

## CDN Access

You can also fetch map files directly from jsDelivr:

```
https://cdn.jsdelivr.net/gh/homayounmmdy/svg-world-maps-data@main/maps/usa.ts
```

For production use, pin to a specific tag:

```
https://cdn.jsdelivr.net/gh/homayounmmdy/svg-world-maps-data@v1.0.0/maps/usa.ts
```

## License

The MIT License applies to the code and tooling in this repository.

**Important:** The SVG map data in the `maps/` directory is sourced 
from [SimpleMaps](https://simplemaps.com) and is governed by the 
[SimpleMaps SVG Map Library License](https://simplemaps.com/resources/svg-license), 
**not** the MIT license.

You may use the map data for personal or commercial projects in 
accordance with the SimpleMaps license. You may **not** redistribute 
the raw map data "as is" or as a standalone product without prior 
written permission from SimpleMaps.

## Related

- [svg-world-maps](https://github.com/homayounmmdy/svg-world-maps) — Main package