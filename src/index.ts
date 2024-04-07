import {connectDevices, Device} from "./dcsm";
import {Receiver} from "sacn";

connectDevices().then((devices : Device[]) => {
    devices.forEach((device) => {
        const data = Buffer.alloc(512);
        data[0] = 0;

        device.setUniverseData(1, data);

        const sACN = new Receiver({
            universes: [1]
        });

        sACN.on("packet", (packet) => {
            const buf = packet.payloadAsBuffer

            if (buf) {
                device.setUniverseData(1, buf);
            }
        });

        device.setAddressValues([
            {

                address: {
                    universe: 1,
                    address: 3
                },
                value: 24
            },
            {
                address: {
                    universe: 1,
                    address: 4
                },
                value: 34
            },
            {
                address: {
                    universe: 1,
                    address: 35
                },
                value: 234
            },
            {
                address: {
                    universe: 1,
                    address: 12
                },
                value: 123
            }
        ]);

        setTimeout(() => {
            device.getUniverseData(1).then(console.log);
        }, 500);
    });
})