# DCSM.js - DMX Serial Management Library

> #### [Latest Specification](https://cdn.goddard.systems/dcsm/specification/latest)
> Latest DCSM specification.

## This Library

This Node.js library exposes a more user-friendly API for managing DCSM devices. 

## Usage
Some usage examples will be in `src/index.ts`, but a simplified example is available below.

```js
import {connectDevices} from "./dcsm";

// Automatically find and connect to attached DCSM devices.
connectDevices().then((devices) => {
    devices.forEach((device) => {
        // Allocate a buffer with 512 slots and initial values of zero.
        const universeData = Buffer.alloc(512, 0);

        // Set address 1 to 200 (buffers are zero-indexed, but will translate
        // to one-indexed address values).
        universeData[0] = 200; 
                               
        // Set universe 1 to the values in the buffer..
        device.setUniverseData(1, universeData);
        
        // Print address values for universe 1.
        device.getUniverseData(1).then(console.log);
    });
});
```