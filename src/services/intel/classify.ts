// the verdict (D4PLAN 14.4). the evidence is the network: the category the
// publisher put it in, the organisation behind it, and the tor exit list.
// the flags are what that evidence suggests, never a proof.
//
// a category cannot tell a commercial vpn from a hosting provider, because
// most commercial vpns are hosting providers. so the page says "likely a vpn
// or hosting provider" and shows the asn, the organisation and the category
// next to it, and the operator judges rather than trusts a boolean.

import type { AsCategory } from "./asmetadata.ts";

export type IpType =
  | "residential"
  | "hosting"
  | "mobile"
  | "business"
  | "education"
  | "government"
  | "unknown";

export interface Classification {
  /** two lowercase letters, or null. */
  readonly countryCode: string | null;
  readonly countryName: string | null;
  readonly isp: string | null;
  /** the number only, "15169". */
  readonly asn: string | null;
  readonly asOrg: string | null;
  readonly ipType: IpType;
  /** the publisher's own category, or null when it placed no category. */
  readonly category: AsCategory | null;
  /** the network's primary function is hosting or cloud. */
  readonly isHosting: boolean;
  readonly isVpn: boolean;
  readonly isProxy: boolean;
  readonly isTor: boolean;
  /** why the verdict came out the way it did, in one line. */
  readonly evidence: string;
}

// the words a network name is read for. they are plain words, because that is
// all the name gives: the organisation and, sometimes, the handle.
const VPN =
  /vpn|cyberghost|windscribe|nordvpn|surfshark|mullvad|protonvpn|expressvpn|hotspot shield|vypr|purevpn|ipvanish|astrill|zenmate|torguard|hide\.me|azirevpn|datacamp/i;
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

/** the category as the ip type the record stores. */
function typeFromCategory(category: AsCategory): IpType {
  switch (category) {
    case "hosting":
      return "hosting";
    case "business":
      return "business";
    case "education_research":
      return "education";
    case "government_admin":
      return "government";
    case "isp":
      return "residential";
  }
}

/**
 * the verdict for one address.
 *
 * the country may arrive as the code or as the name, and the shape of the
 * string decides which slot it goes in. an address the databases do not know
 * is unknown, never residential by default.
 */
export function classify(input: {
  countryCode?: string | null;
  countryName?: string | null;
  asOrg?: string | null;
  isp?: string | null;
  asn?: string | null;
  category?: AsCategory | null;
  /** the address is on the tor exit list, so this is not a guess. */
  isTorExit?: boolean;
  /** the database itself calls the address an anonymous proxy. */
  isAnonymousProxy?: boolean;
}): Classification {
  const countryCode = clean(input.countryCode)?.toLowerCase() ?? null;
  const countryName = clean(input.countryName);
  const asOrg = clean(input.asOrg);
  const isp = clean(input.isp);
  const asn = clean(input.asn);
  const category = input.category ?? null;
  const code = countryCode !== null && /^[a-z]{2}$/.test(countryCode) ? countryCode : null;

  // everything the databases know about the address, as one text to read.
  const evidence = [asOrg, isp, countryName].filter((part) => part !== null).join(" ");

  const isTor = input.isTorExit === true || (evidence !== "" && TOR.test(evidence));
  const isVpn = evidence !== "" && VPN.test(evidence);
  // a vpn exit and a tor exit are proxies as well, which is what an operator
  // means by the word. a database that calls the address an anonymous proxy
  // is taken at its word.
  const isProxy =
    /proxy|socks/i.test(evidence) || isVpn || isTor || input.isAnonymousProxy === true;

  // the category is the publisher's own answer, so it wins over the name. the
  // name is only read when the network was left unclassified.
  let ipType: IpType;
  if (category !== null) {
    ipType = typeFromCategory(category);
    // a mobile network that sells fixed lines is still a mobile network.
    if (ipType === "residential" && MOBILE.test(evidence)) ipType = "mobile";
  } else if (evidence === "") {
    ipType = "unknown";
  } else if (HOSTING.test(evidence) || isVpn || isTor) {
    ipType = "hosting";
  } else if (MOBILE.test(evidence)) {
    ipType = "mobile";
  } else {
    ipType = "residential";
  }

  // hosting is what the category says. without a category it is read out of
  // the name, which is a guess and is called one.
  const isHosting =
    category === "hosting" || (category === null && evidence !== "" && HOSTING.test(evidence));

  return {
    countryCode: code,
    countryName: countryName,
    isp,
    asn,
    asOrg,
    ipType,
    category,
    isHosting,
    isVpn,
    isProxy,
    isTor,
    evidence: explain({
      category,
      asOrg,
      isTorExit: input.isTorExit === true,
      isVpn,
      isHosting,
      isAnonymousProxy: input.isAnonymousProxy === true,
    }),
  };
}

/** one line the operator can read: what the verdict was made from. */
function explain(input: {
  category: AsCategory | null;
  asOrg: string | null;
  isTorExit: boolean;
  isVpn: boolean;
  isHosting: boolean;
  isAnonymousProxy: boolean;
}): string {
  const parts: string[] = [];
  if (input.isTorExit) parts.push("the address is on the tor exit list");
  if (input.isAnonymousProxy) parts.push("the database calls the address an anonymous proxy");
  if (input.category !== null) parts.push(`the network is filed as ${input.category}`);
  if (input.isVpn) parts.push("the organisation's name reads as a vpn provider");
  if (input.isHosting && input.category === null) {
    parts.push("the organisation's name reads as a hosting provider");
  }
  if (input.asOrg !== null) parts.push(`run by ${input.asOrg}`);
  if (parts.length === 0) return "nothing in the files covers this address";
  return parts.join(", ");
}
