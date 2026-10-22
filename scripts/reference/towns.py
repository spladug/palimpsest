"""The reference towns: where they are, which council's INSPIRE file holds
their plots, and the medieval main streets that make up each town's core
(as named in OpenStreetMap)."""

TOWNS = {
    "totnes": {
        "name": "Totnes",
        "county": "Devon",
        "geocode": "Totnes, Devon, England",
        "council": "South_Hams_District_Council",
        # The burh's spine: Fore Street climbing from the bridge to the East Gate, High Street within the walls.
        "core": ["Fore Street", "High Street"],
    },
    "skipton": {
        "name": "Skipton",
        "county": "Yorkshire",
        "geocode": "Skipton, North Yorkshire, England",
        "council": "The_North_Yorkshire_Council",
        # The wide market street below the castle, and Sheep Street beside it.
        "core": ["High Street", "Sheep Street"],
    },
    "ross": {
        "name": "Ross-on-Wye",
        "county": "Herefordshire",
        "geocode": "Ross-on-Wye, Herefordshire, England",
        "council": "Herefordshire_Council",
        # The market place by the market hall, and the streets running from it.
        "core": ["High Street", "Broad Street", "Market Place", "Church Street"],
    },
    "hitchin": {
        "name": "Hitchin",
        "county": "Hertfordshire",
        "geocode": "Hitchin, Hertfordshire, England",
        "council": "North_Hertfordshire_District_Council",
        "core": ["Bancroft", "High Street", "Market Place", "Bucklersbury", "Sun Street", "Tilehouse Street", "Bridge Street"],
    },
    "baldock": {
        "name": "Baldock",
        "county": "Hertfordshire",
        "geocode": "Baldock, Hertfordshire, England",
        "council": "North_Hertfordshire_District_Council",
        # The Templars' planted town: wide streets meeting at a crossing.
        "core": ["High Street", "Whitehorse Street", "Hitchin Street", "Church Street"],
        "radius": 1200,
    },
}

# Street-name words that date a street to Victoria's reign or after (the same
# dating as scripts/validation/targets.ts), as a stand-in for period zoning.
# Not Station or Railway Road: those are older roads to the station as often
# as new streets, and run past yards and works as much as houses.
VICTORIAN_WORDS = [
    "Victoria", "Albert", "Alma", "Inkerman", "Balaclava", "Sebastopol", "Garibaldi", "Gladstone", "Palmerston",
    "Cobden", "Osborne", "Balmoral", "Sandringham", "Jubilee",
]
