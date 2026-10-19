// the verdict (D4PLAN 14.4). the evidence is the network: its asn and the
// organisation behind it. the flags are what that evidence suggests, never a
// proof.
//
// an asn cannot tell a commercial vpn from a hosting provider, because most
// commercial vpns are hosting providers. so the ui says "likely a vpn or
// hosting provider" and shows the asn and the organisation next to it, and
// the operator judges rather than trusts a boolean.

export type IpType = "residential" | "hosting" | "mobile" | "unknown";

export interface Classification {
  /** two lowercase letters, or null. */
  readonly countryCode: string | null;
  readonly countryName: string | null;
  readonly isp: string | null;
  /** the number only, "15169". the classifier has no asn of its own. */
  readonly asn: string | null;
  readonly asOrg: string | null;
  readonly ipType: IpType;
  readonly isVpn: boolean;
  readonly isProxy: boolean;
  readonly isTor: boolean;
}

// the words a network name is read for. they are plain words, because that is
// all the file gives: the organisation name and, sometimes, the handle.
const VPN = /vpn/i;
const PROXY = /proxy/i;
// "tor" only as a word of its own, so a place called Toronto stays a place.
const TOR = /\btors?\b|onion router|tor project/i;
const HOSTING =
  /hosting|datacenter|data cent(er|re)|colocation|server farm|dedicated host|\bvps\b|\bidc\b|cloud/i;
// the mobile networks whose name does not say mobile.
const MOBILE =
  /mobile|cellular|wireless|gsm|\blte\b|\b[345]g\b|\bmcc\b|\bmnc\b|telecom|vodafone|telstra|optus|telefonica|movistar|telenor|telia|airtel|docomo|kddi|telkomsel|iliad|\bree\b|\borange\b/i;

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * the verdict for one address.
 *
 * the country may arrive as the code or as the name, and the shape of the
 * string decides which slot it goes in. an address the databases do not know
 * is unknown, never residential by default.
 */
export function classify(input: {
  country?: string | null;
  asOrg?: string | null;
  isp?: string | null;
}): Classification {
  const country = clean(input.country);
  const asOrg = clean(input.asOrg);
  const isp = clean(input.isp);
  const isCode = country !== null && /^[a-z]{2}$/.test(country);

  // everything the databases know about the address, as one text to read.
  const evidence = [asOrg, isp, country].filter((part) => part !== null).join(" ");
  if (evidence === "") {
    return {
      countryCode: null,
      countryName: null,
      isp: null,
      asn: null,
      asOrg: null,
      ipType: "unknown",
      isVpn: false,
      isProxy: false,
      isTor: false,
    };
  }

  const isVpn = VPN.test(evidence);
  const isTor = TOR.test(evidence);
  // a vpn exit and a tor exit are proxies as well, which is what an operator
  // means by the word.
  const isProxy = PROXY.test(evidence) || isVpn || isTor;
  // most commercial vpns run on hosting providers, so a network that is a vpn
  // or a tor exit is a hosting network, not a residential one.
  const ipType: IpType =
    HOSTING.test(evidence) || isVpn || isTor
      ? "hosting"
      : MOBILE.test(evidence)
        ? "mobile"
        : "residential";

  return {
    countryCode: isCode ? country : null,
    countryName: isCode ? null : country,
    isp,
    asn: null,
    asOrg,
    ipType,
    isVpn,
    isProxy,
    isTor,
  };
}
