"""Single source of truth for Orbit: modules, satellite regions, consumer items.

Prices in GBP (London). `commodity_share` = share of the retail price driven by the
underlying commodity, used by the simple pass-through model:
    retail_future = retail_now * (1 + commodity_share * commodity_change)
"""

MODULES = [
    {"id": "groceries", "name": "Groceries", "emoji": "🛒", "color": "#F97316",
     "news_query": '(cocoa OR "olive oil" OR "orange juice" OR wheat) (harvest OR drought OR crop OR prices)'},
    {"id": "latte", "name": "Latte Index", "emoji": "☕", "color": "#A16207",
     "news_query": 'coffee (harvest OR drought OR frost OR crop OR arabica OR robusta)'},
    {"id": "beer_wine", "name": "Beer & Wine", "emoji": "🍺", "color": "#EAB308",
     "news_query": '(barley OR hops OR vineyard OR grape OR wine) (harvest OR drought OR heatwave OR crop)'},
    {"id": "gpu", "name": "GPU & Gadgets", "emoji": "🖥️", "color": "#6366F1",
     "news_query": '(TSMC OR semiconductor OR "chip shortage" OR GPU OR DRAM) (water OR drought OR supply OR prices OR shipping)'},
    {"id": "rent", "name": "Rent Radar", "emoji": "🏠", "color": "#10B981",
     "news_query": 'London (rent OR rents OR housing OR "new homes" OR construction)'},
]

# Satellite regions. bbox = [min_lon, min_lat, max_lon, max_lat] (~0.1°, small reads).
# signal: "crop" -> NDVI (vegetation health), "water" -> NDWI (reservoir extent),
#         "built" -> NDBI (construction), "port" -> activity proxy.
REGIONS = [
    # Groceries
    {"id": "jaen_olives", "module": "groceries", "item": "olive_oil", "name": "Jaén olive groves, Spain", "lat": 37.85, "lon": -3.75, "signal": "crop"},
    {"id": "soubre_cocoa", "module": "groceries", "item": "chocolate", "name": "Soubré cocoa belt, Côte d'Ivoire", "lat": 5.80, "lon": -6.60, "signal": "crop"},
    {"id": "ashanti_cocoa", "module": "groceries", "item": "chocolate", "name": "Ashanti cocoa farms, Ghana", "lat": 6.70, "lon": -1.60, "signal": "crop"},
    {"id": "saopaulo_oranges", "module": "groceries", "item": "orange_juice", "name": "São Paulo citrus belt, Brazil", "lat": -20.90, "lon": -48.50, "signal": "crop"},
    {"id": "poltava_wheat", "module": "groceries", "item": "bread", "name": "Poltava wheat fields, Ukraine", "lat": 49.60, "lon": 34.50, "signal": "crop"},
    # Latte
    {"id": "minas_coffee", "module": "latte", "item": "latte", "name": "Sul de Minas coffee, Brazil", "lat": -21.50, "lon": -45.40, "signal": "crop"},
    {"id": "daklak_coffee", "module": "latte", "item": "latte", "name": "Đắk Lắk robusta, Vietnam", "lat": 12.70, "lon": 108.00, "signal": "crop"},
    {"id": "huila_coffee", "module": "latte", "item": "latte", "name": "Huila coffee, Colombia", "lat": 2.50, "lon": -75.80, "signal": "crop"},
    # Beer & wine
    {"id": "hallertau_hops", "module": "beer_wine", "item": "pint", "name": "Hallertau hops, Bavaria", "lat": 48.55, "lon": 11.80, "signal": "crop"},
    {"id": "zatec_hops", "module": "beer_wine", "item": "pint", "name": "Žatec hops, Czechia", "lat": 50.33, "lon": 13.55, "signal": "crop"},
    {"id": "bordeaux_vines", "module": "beer_wine", "item": "wine", "name": "Bordeaux vineyards, France", "lat": 44.90, "lon": -0.30, "signal": "crop"},
    {"id": "rioja_vines", "module": "beer_wine", "item": "wine", "name": "Rioja vineyards, Spain", "lat": 42.45, "lon": -2.60, "signal": "crop"},
    # GPU & gadgets
    {"id": "baoshan_reservoir", "module": "gpu", "item": "gpu", "name": "Baoshan reservoir (Hsinchu fabs), Taiwan", "lat": 24.72, "lon": 121.06, "signal": "water"},
    {"id": "tsengwen_reservoir", "module": "gpu", "item": "gpu", "name": "Tsengwen reservoir (Tainan fabs), Taiwan", "lat": 23.25, "lon": 120.53, "signal": "water"},
    {"id": "hsinchu_park", "module": "gpu", "item": "laptop", "name": "Hsinchu Science Park, Taiwan", "lat": 24.78, "lon": 121.00, "signal": "built"},
    {"id": "kaohsiung_port", "module": "gpu", "item": "laptop", "name": "Port of Kaohsiung, Taiwan", "lat": 22.60, "lon": 120.28, "signal": "port"},
]

for _r in REGIONS:
    d = 0.05
    _r.setdefault("bbox", [_r["lon"] - d, _r["lat"] - d, _r["lon"] + d, _r["lat"] + d])

# Consumer items shown in the UI. fred_series = monthly commodity benchmark (None -> synthetic).
ITEMS = [
    {"id": "chocolate", "module": "groceries", "name": "Chocolate bar (100g)", "unit": "£", "retail_now": 1.85, "commodity_share": 0.35, "fred_series": "PCOCOUSDM"},
    {"id": "olive_oil", "module": "groceries", "name": "Olive oil (1L)", "unit": "£", "retail_now": 9.50, "commodity_share": 0.70, "fred_series": "POLVOILUSDM"},
    {"id": "orange_juice", "module": "groceries", "name": "Orange juice (1L)", "unit": "£", "retail_now": 2.30, "commodity_share": 0.45, "fred_series": "PORANGUSDM"},
    {"id": "bread", "module": "groceries", "name": "Loaf of bread", "unit": "£", "retail_now": 1.45, "commodity_share": 0.20, "fred_series": "PWHEAMTUSDM"},
    {"id": "latte", "module": "latte", "name": "Latte (London café)", "unit": "£", "retail_now": 3.95, "commodity_share": 0.12, "fred_series": "PCOFFOTMUSDM"},
    {"id": "pint", "module": "beer_wine", "name": "Pint of lager", "unit": "£", "retail_now": 6.40, "commodity_share": 0.08, "fred_series": "PBARLUSDM"},
    {"id": "wine", "module": "beer_wine", "name": "Bottle of wine", "unit": "£", "retail_now": 9.00, "commodity_share": 0.25, "fred_series": None},
    {"id": "gpu", "module": "gpu", "name": "High-end GPU", "unit": "£", "retail_now": 1650.0, "commodity_share": 0.60, "fred_series": "PCU334413334413"},
    {"id": "laptop", "module": "gpu", "name": "Laptop", "unit": "£", "retail_now": 1150.0, "commodity_share": 0.40, "fred_series": None},
    {"id": "rent_1bed", "module": "rent", "name": "1-bed flat rent (London avg, /month)", "unit": "£", "retail_now": 2250.0, "commodity_share": 1.0, "fred_series": None},
]

# Headline backtests for the demo ("Orbit would have seen it coming").
BACKTESTS = [
    {"item_id": "olive_oil", "as_of": "2023-03", "story": "Spain's 2023 drought → olive oil price doubled"},
    {"item_id": "chocolate", "as_of": "2023-09", "story": "West Africa 2024 cocoa crisis → cocoa tripled"},
    {"item_id": "latte", "as_of": "2024-03", "story": "Brazil 2024 drought → coffee at record highs"},
]

# London Rent Radar area.
LONDON_BBOX = [-0.51, 51.28, 0.33, 51.70]
LONDON_BOROUGHS_GEOJSON = "https://raw.githubusercontent.com/radoi90/housequest-data/master/london_boroughs.geojson"

HISTORY_START = "2019-01"   # satellite + price history window
FORECAST_MONTHS = 12

MODULE_BY_ID = {m["id"]: m for m in MODULES}
ITEM_BY_ID = {i["id"]: i for i in ITEMS}
REGION_BY_ID = {r["id"]: r for r in REGIONS}
