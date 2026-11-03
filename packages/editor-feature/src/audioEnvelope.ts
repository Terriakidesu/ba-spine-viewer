/** Return one absolute-peak value for each display bucket of decoded mono PCM. */
export function audioEnvelopePeaks(channel: Float32Array, bucketCount = 160): number[] {
  if (!Number.isInteger(bucketCount) || bucketCount < 1 || bucketCount > 4096) {
    throw new RangeError("Audio envelope bucket count must be an integer from 1 to 4096.");
  }
  const peaks = new Array<number>(bucketCount);
  for (let index = 0; index < bucketCount; index++) {
    const start = Math.floor(index * channel.length / bucketCount);
    const end = Math.floor((index + 1) * channel.length / bucketCount);
    let peak = 0;
    for (let sample = start; sample < end; sample++) peak = Math.max(peak, Math.abs(channel[sample]!));
    peaks[index] = peak;
  }
  return peaks;
}
