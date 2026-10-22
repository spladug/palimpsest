// Historical targets for the medieval England scenario: what a small English
// market town that industrialised should show. Each gives a range and where it
// comes from. These are deliberately broad national or typical figures until
// the reference pipeline (docs/validation.md, step 3) supplies measured towns.

export interface Range {
  min: number;
  max: number;
  source: string;
}

/** Population: ratios of town households between dates, and the size about 1300. */
export const POPULATION = {
  /** Households about 1300: a small market town of a few hundred to about two thousand people, at 4–5 a household. */
  sizeAt1300: { min: 60, max: 450, source: 'Dyer, Making a Living in the Middle Ages (2002): most small towns 500–2,000 people' },
  /** Share of households lost in the first plague (1348–49). */
  blackDeathLoss: { min: 0.3, max: 0.6, source: 'Hatcher, Plague, Population and the English Economy (1977): 30–45%; Benedictow, The Black Death (2004): up to 60%' },
  /** Households about 1450 against the peak before the plague: the late-medieval trough. */
  troughVsPeak: { min: 0.35, max: 0.75, source: 'Broadberry et al., British Economic Growth 1270–1870 (2015): England c. 4.8m (1300) to c. 2m (1450)' },
  /** Growth 1450 to 1600: recovery. */
  recovery1450to1600: { min: 1.3, max: 2.6, source: 'Wrigley & Schofield, Population History of England (1981): 2.8m (1541) to 4.1m (1601), growth under way from the later 15th century' },
  /** Growth 1600 to 1750. */
  growth1600to1750: { min: 1.0, max: 1.8, source: 'Wrigley & Schofield (1981): 4.1m (1601) to 5.8m (1751)' },
  /** Growth through the 19th century. Market towns roughly doubled; textile and railway towns grew several-fold. */
  growth1801to1901: { min: 1.5, max: 8, source: 'Census 1801–1901; England & Wales 8.9m to 32.5m (×3.6), small market towns ×1.5–2.5, industrial towns more' },
} satisfies Record<string, Range>;

export interface EventTarget extends Range {
  /** Matches the chronicle entry for the event. */
  pattern: RegExp;
  /** The event must happen in every run (else only checked when it does). */
  required?: boolean;
}

/** When things first happened, by the chronicle. */
export const EVENTS: Record<string, EventTarget> = {
  'market charter': {
    pattern: /plants a borough/,
    min: 1100,
    max: 1300,
    required: true,
    source: 'Beresford & Finberg, English Medieval Boroughs (1973): most new boroughs 1100–1300',
  },
  friary: {
    pattern: /A friary is set up/,
    min: 1224,
    max: 1350,
    source: 'Knowles & Hadcock, Medieval Religious Houses (1971): friars reach England 1224, most houses founded by 1300',
  },
  dissolution: { pattern: /friary is dissolved|is dissolved/, min: 1536, max: 1540, source: 'Dissolution of the monasteries and friaries, 1536–40' },
  'grammar school': {
    pattern: /A grammar school is set up/,
    min: 1540,
    max: 1700,
    source: 'Stone, "The educational revolution in England 1560–1640" (1964); many town grammar schools founded or refounded 1540–1640',
  },
  enclosure: {
    pattern: /Act of Parliament encloses/,
    min: 1750,
    max: 1850,
    required: true,
    source: 'Turner, English Parliamentary Enclosure (1980): most open-field Acts 1750–1830',
  },
  chapel: { pattern: /A chapel opens/, min: 1689, max: 1950, source: 'Toleration Act 1689 allowed licensed nonconformist chapels' },
  workhouse: { pattern: /A workhouse is set up/, min: 1723, max: 1850, source: "Knatchbull's Act 1723; Poor Law Amendment Act 1834 and union workhouses by c. 1850" },
  gasworks: { pattern: /A gasworks is set up/, min: 1815, max: 1880, source: 'Town gas companies spread from London (1812) to most towns by the 1850s–60s' },
  cemetery: { pattern: /A cemetery is set up/, min: 1830, max: 1900, source: 'Burial Acts 1852–57; earlier private and joint-stock cemeteries from the 1820s–30s' },
  'board school': { pattern: /A board school is set up/, min: 1870, max: 1902, source: 'Elementary Education Act 1870; school boards abolished 1902' },
};

/**
 * The earliest year a street name could be given. Names after battles, royalty
 * and statesmen are dated by the event or the person's prominence.
 */
export const NAMES_FROM: Record<string, Range> = {
  Nelson: { min: 1798, max: Infinity, source: 'Battle of the Nile, 1798' },
  Trafalgar: { min: 1805, max: Infinity, source: 'Battle of Trafalgar, 1805' },
  Wellington: { min: 1809, max: Infinity, source: 'Viscount Wellington, 1809' },
  Waterloo: { min: 1815, max: Infinity, source: 'Battle of Waterloo, 1815' },
  Regent: { min: 1811, max: Infinity, source: 'Regency, 1811' },
  Union: { min: 1801, max: Infinity, source: 'Union with Ireland, 1801 (or 1707)' },
  Victoria: { min: 1837, max: Infinity, source: 'Accession of Victoria, 1837' },
  Albert: { min: 1840, max: Infinity, source: 'Marriage of Victoria and Albert, 1840' },
  Alma: { min: 1854, max: Infinity, source: 'Battle of the Alma, 1854' },
  Inkerman: { min: 1854, max: Infinity, source: 'Battle of Inkerman, 1854' },
  Garibaldi: { min: 1860, max: Infinity, source: 'Expedition of the Thousand, 1860' },
  Gladstone: { min: 1853, max: Infinity, source: 'Gladstone Chancellor of the Exchequer, 1852–55' },
  Palmerston: { min: 1855, max: Infinity, source: 'Palmerston Prime Minister, 1855' },
  Cobden: { min: 1846, max: Infinity, source: 'Repeal of the Corn Laws, 1846' },
  Peel: { min: 1830, max: Infinity, source: 'Peel Home Secretary 1822–30, Prime Minister 1834' },
  Osborne: { min: 1845, max: Infinity, source: 'Osborne House bought 1845' },
  Balmoral: { min: 1852, max: Infinity, source: 'Balmoral bought 1852' },
  Sandringham: { min: 1862, max: Infinity, source: 'Sandringham bought 1862' },
  Jubilee: { min: 1809, max: Infinity, source: 'Jubilee of George III, 1809; Victoria 1887, 1897' },
  Railway: { min: 1830, max: Infinity, source: 'Liverpool & Manchester Railway, 1830; and only where there is a railway' },
  Edward: { min: 1901, max: Infinity, source: 'Accession of Edward VII, 1901' },
  Coronation: { min: 1902, max: Infinity, source: 'Coronation of Edward VII, 1902' },
  Ladysmith: { min: 1900, max: Infinity, source: 'Relief of Ladysmith, 1900' },
  Kitchener: { min: 1898, max: Infinity, source: 'Battle of Omdurman, 1898' },
};
