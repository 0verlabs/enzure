/**
 * NEAR amounts without loading near-api-js into every page: 1 NEAR is 10^24
 * yoctoNEAR.
 */
const DECIMALS = 24;
const ONE_NEAR = 10n ** BigInt(DECIMALS);

/** `1.25` for 1.25 NEAR in yoctoNEAR, rounded down to `fractionDigits`, without trailing zeros. */
export function yoctoToNear(yocto: string | bigint, fractionDigits = DECIMALS): string {
  const value = BigInt(yocto);
  const whole = value / ONE_NEAR;
  const fraction = (value % ONE_NEAR)
    .toString()
    .padStart(DECIMALS, "0")
    .slice(0, fractionDigits)
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/** yoctoNEAR for a decimal NEAR amount such as `1.5`, or null if it isn't one. */
export function nearToYocto(near: string): string | null {
  const match = /^(\d+)(?:\.(\d{0,24}))?$/.exec(near.trim());
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  return (BigInt(whole!) * ONE_NEAR + BigInt(fraction.padEnd(DECIMALS, "0"))).toString();
}
