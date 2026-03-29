type StampDelta = {
    delta: number,
    remainingStamp: number
}

export class Volatility {
    lastDelta: number;
    deltaHistory: StampDelta[]

    constructor() {
        this.deltaHistory = []
    }

    insertHistory = (delta, remainingStamp) => {
        if (this.deltaHistory.length == 0 || this.lastDelta != delta) {
            this.deltaHistory.push({
                delta,
                remainingStamp
            });
            this.lastDelta = delta
        }
    }

    getVolatility = (remainingStamp: number, delta: number) => {
        const filteredStamps: StampDelta[] = this.deltaHistory
            .filter(deltas => deltas.remainingStamp - remainingStamp <= remainingStamp) // remove unwanted
            .map(deltas => ({
                delta: deltas.delta - delta, // transform
                remainingStamp: deltas.remainingStamp
            }));

        const maxDeltaObject = filteredStamps.reduce((max, deltas) =>
            Math.abs(deltas.delta) > Math.abs(max.delta) ? deltas : max, filteredStamps[0]);

        return maxDeltaObject;
    }

    clearHistory = () => {
        this.deltaHistory = []
    }
}