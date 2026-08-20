"""
Birth data registry for all 62 test cases (49 blind + 13 adversarial).

Sources: AstroSage, Astrodatabank (Rodden ratings noted), public biographies.
Pre-standard-time births use IST (+5.5) for Indian charts, LMT for Western charts
where applicable. Most Vedic astrology software handles this internally.

Design: BIRTH_DATA keyed by person slug. CASES maps test case IDs to persons + event dates.
Multiple cases can reference the same person (e.g., JFK death + JFK marriage).
"""

BIRTH_DATA = {
    # ──────────── Indian Politicians / Leaders ────────────
    'narendra_modi': {
        'name': 'Narendra Modi',
        'year': 1950, 'month': 9, 'day': 17, 'hour': 11, 'minute': 0,
        'place_name': 'Vadnagar, Gujarat, India',
        'latitude': 23.78, 'longitude': 72.64, 'timezone_offset': 5.5,
    },
    'jawaharlal_nehru': {
        'name': 'Jawaharlal Nehru',
        'year': 1889, 'month': 11, 'day': 14, 'hour': 23, 'minute': 36,
        'place_name': 'Allahabad, India',
        'latitude': 25.43, 'longitude': 81.85, 'timezone_offset': 5.5,
    },
    'rajiv_gandhi': {
        'name': 'Rajiv Gandhi',
        'year': 1944, 'month': 8, 'day': 20, 'hour': 8, 'minute': 11,
        'place_name': 'Mumbai, India',
        'latitude': 19.08, 'longitude': 72.88, 'timezone_offset': 5.5,
    },
    'mahatma_gandhi': {
        'name': 'Mahatma Gandhi',
        'year': 1869, 'month': 10, 'day': 2, 'hour': 7, 'minute': 9,
        'place_name': 'Porbandar, Gujarat, India',
        'latitude': 21.64, 'longitude': 69.61, 'timezone_offset': 5.5,
    },
    'atal_bihari_vajpayee': {
        'name': 'Atal Bihari Vajpayee',
        'year': 1924, 'month': 12, 'day': 25, 'hour': 5, 'minute': 45,
        'place_name': 'Gwalior, Madhya Pradesh, India',
        'latitude': 26.22, 'longitude': 78.18, 'timezone_offset': 5.5,
    },
    'sanjay_gandhi': {
        'name': 'Sanjay Gandhi',
        'year': 1946, 'month': 12, 'day': 14, 'hour': 9, 'minute': 27,
        'place_name': 'New Delhi, India',
        'latitude': 28.61, 'longitude': 77.21, 'timezone_offset': 5.5,
    },
    'jayalalithaa': {
        'name': 'Jayalalithaa',
        'year': 1948, 'month': 2, 'day': 24, 'hour': 14, 'minute': 40,
        'place_name': 'Mysore, Karnataka, India',
        'latitude': 12.30, 'longitude': 76.66, 'timezone_offset': 5.5,
    },
    'pv_narasimha_rao': {
        'name': 'P. V. Narasimha Rao',
        'year': 1921, 'month': 6, 'day': 28, 'hour': 11, 'minute': 30,
        'place_name': 'Karimnagar, Telangana, India',
        'latitude': 18.44, 'longitude': 79.13, 'timezone_offset': 5.5,
    },
    'swami_vivekananda': {
        'name': 'Swami Vivekananda',
        'year': 1863, 'month': 1, 'day': 12, 'hour': 6, 'minute': 33,
        'place_name': 'Kolkata, India',
        'latitude': 22.57, 'longitude': 88.36, 'timezone_offset': 5.5,
    },
    'benazir_bhutto': {
        'name': 'Benazir Bhutto',
        'year': 1953, 'month': 6, 'day': 21, 'hour': 21, 'minute': 0,
        'place_name': 'Karachi, Pakistan',
        'latitude': 24.86, 'longitude': 67.01, 'timezone_offset': 5,
    },

    # ──────────── Indian Entertainment / Sports ────────────
    'sachin_tendulkar': {
        'name': 'Sachin Tendulkar',
        'year': 1973, 'month': 4, 'day': 24, 'hour': 14, 'minute': 25,
        'place_name': 'Mumbai, India',
        'latitude': 19.08, 'longitude': 72.88, 'timezone_offset': 5.5,
    },
    'amitabh_bachchan': {
        'name': 'Amitabh Bachchan',
        'year': 1942, 'month': 10, 'day': 11, 'hour': 16, 'minute': 0,
        'place_name': 'Allahabad, India',
        'latitude': 25.43, 'longitude': 81.85, 'timezone_offset': 5.5,
    },
    'rajinikanth': {
        'name': 'Rajinikanth',
        'year': 1950, 'month': 12, 'day': 12, 'hour': 23, 'minute': 49,
        'place_name': 'Bangalore, India',
        'latitude': 12.97, 'longitude': 77.59, 'timezone_offset': 5.5,
    },
    'aishwarya_rai': {
        'name': 'Aishwarya Rai',
        'year': 1973, 'month': 11, 'day': 1, 'hour': 4, 'minute': 5,
        'place_name': 'Mangalore, Karnataka, India',
        'latitude': 12.87, 'longitude': 74.84, 'timezone_offset': 5.5,
    },
    'yuvraj_singh': {
        'name': 'Yuvraj Singh',
        'year': 1981, 'month': 12, 'day': 12, 'hour': 12, 'minute': 0,
        'place_name': 'Chandigarh, India',
        'latitude': 30.73, 'longitude': 76.78, 'timezone_offset': 5.5,
    },
    'sanjay_dutt': {
        'name': 'Sanjay Dutt',
        'year': 1959, 'month': 7, 'day': 29, 'hour': 14, 'minute': 45,
        'place_name': 'Mumbai, India',
        'latitude': 19.08, 'longitude': 72.88, 'timezone_offset': 5.5,
    },

    # ──────────── Indian Business ────────────
    'dhirubhai_ambani': {
        'name': 'Dhirubhai Ambani',
        'year': 1932, 'month': 12, 'day': 28, 'hour': 6, 'minute': 37,
        'place_name': 'Chorwad, Gujarat, India',
        'latitude': 21.03, 'longitude': 70.23, 'timezone_offset': 5.5,
    },
    'mukesh_ambani': {
        'name': 'Mukesh Ambani',
        'year': 1957, 'month': 4, 'day': 19, 'hour': 19, 'minute': 53,
        'place_name': 'Aden, Yemen',
        'latitude': 12.78, 'longitude': 45.04, 'timezone_offset': 3,
    },

    # ──────────── US Presidents / Politicians ────────────
    'barack_obama': {
        'name': 'Barack Obama',
        'year': 1961, 'month': 8, 'day': 4, 'hour': 19, 'minute': 24,
        'place_name': 'Honolulu, Hawaii, USA',
        'latitude': 21.31, 'longitude': -157.86, 'timezone_offset': -10,
    },
    'richard_nixon': {
        'name': 'Richard Nixon',
        'year': 1913, 'month': 1, 'day': 9, 'hour': 21, 'minute': 35,
        'place_name': 'Yorba Linda, California, USA',
        'latitude': 33.89, 'longitude': -117.82, 'timezone_offset': -8,
    },
    'donald_trump': {
        'name': 'Donald Trump',
        'year': 1946, 'month': 6, 'day': 14, 'hour': 10, 'minute': 54,
        'place_name': 'Queens, New York, USA',
        'latitude': 40.73, 'longitude': -73.79, 'timezone_offset': -4,  # EDT
    },
    'bill_clinton': {
        'name': 'Bill Clinton',
        'year': 1946, 'month': 8, 'day': 19, 'hour': 8, 'minute': 51,
        'place_name': 'Hope, Arkansas, USA',
        'latitude': 33.67, 'longitude': -93.59, 'timezone_offset': -5,
    },
    'jfk': {
        'name': 'John F. Kennedy',
        'year': 1917, 'month': 5, 'day': 29, 'hour': 15, 'minute': 0,
        'place_name': 'Brookline, Massachusetts, USA',
        'latitude': 42.33, 'longitude': -71.12, 'timezone_offset': -5,
    },
    'abraham_lincoln': {
        'name': 'Abraham Lincoln',
        'year': 1809, 'month': 2, 'day': 12, 'hour': 6, 'minute': 54,
        'place_name': 'Hodgenville, Kentucky, USA',
        'latitude': 37.57, 'longitude': -85.74, 'timezone_offset': -5.72,  # LMT
    },

    # ──────────── World Leaders ────────────
    'margaret_thatcher': {
        'name': 'Margaret Thatcher',
        'year': 1925, 'month': 10, 'day': 13, 'hour': 9, 'minute': 0,
        'place_name': 'Grantham, Lincolnshire, UK',
        'latitude': 52.91, 'longitude': -0.64, 'timezone_offset': 0,
    },
    'winston_churchill': {
        'name': 'Winston Churchill',
        'year': 1874, 'month': 11, 'day': 30, 'hour': 1, 'minute': 30,
        'place_name': 'Blenheim Palace, Woodstock, UK',
        'latitude': 51.84, 'longitude': -1.36, 'timezone_offset': 0,
    },
    'mussolini': {
        'name': 'Benito Mussolini',
        'year': 1883, 'month': 7, 'day': 29, 'hour': 14, 'minute': 0,
        'place_name': 'Predappio, Italy',
        'latitude': 44.10, 'longitude': 11.98, 'timezone_offset': 1,
    },

    # ──────────── Entertainment (Western) ────────────
    'michael_jackson': {
        'name': 'Michael Jackson',
        'year': 1958, 'month': 8, 'day': 29, 'hour': 19, 'minute': 33,
        'place_name': 'Gary, Indiana, USA',
        'latitude': 41.59, 'longitude': -87.35, 'timezone_offset': -5,  # CDT
    },
    'elvis_presley': {
        'name': 'Elvis Presley',
        'year': 1935, 'month': 1, 'day': 8, 'hour': 4, 'minute': 35,
        'place_name': 'Tupelo, Mississippi, USA',
        'latitude': 34.26, 'longitude': -88.70, 'timezone_offset': -6,
    },
    'princess_diana': {
        'name': 'Princess Diana',
        'year': 1961, 'month': 7, 'day': 1, 'hour': 19, 'minute': 45,
        'place_name': 'Sandringham, Norfolk, UK',
        'latitude': 52.83, 'longitude': 0.51, 'timezone_offset': 1,  # BST
    },
    'marilyn_monroe': {
        'name': 'Marilyn Monroe',
        'year': 1926, 'month': 6, 'day': 1, 'hour': 9, 'minute': 30,
        'place_name': 'Los Angeles, California, USA',
        'latitude': 34.05, 'longitude': -118.24, 'timezone_offset': -8,
    },
    'bruce_lee': {
        'name': 'Bruce Lee',
        'year': 1940, 'month': 11, 'day': 27, 'hour': 7, 'minute': 12,
        'place_name': 'San Francisco, California, USA',
        'latitude': 37.77, 'longitude': -122.42, 'timezone_offset': -8,
    },
    'elizabeth_taylor': {
        'name': 'Elizabeth Taylor',
        'year': 1932, 'month': 2, 'day': 27, 'hour': 2, 'minute': 30,
        'place_name': 'London, UK',
        'latitude': 51.51, 'longitude': -0.13, 'timezone_offset': 0,
    },
    'whitney_houston': {
        'name': 'Whitney Houston',
        'year': 1963, 'month': 8, 'day': 9, 'hour': 20, 'minute': 55,
        'place_name': 'Newark, New Jersey, USA',
        'latitude': 40.74, 'longitude': -74.17, 'timezone_offset': -4,  # EDT
    },
    'oprah_winfrey': {
        'name': 'Oprah Winfrey',
        'year': 1954, 'month': 1, 'day': 29, 'hour': 4, 'minute': 30,
        'place_name': 'Kosciusko, Mississippi, USA',
        'latitude': 33.06, 'longitude': -89.59, 'timezone_offset': -6,
    },
    'angelina_jolie': {
        'name': 'Angelina Jolie',
        'year': 1975, 'month': 6, 'day': 4, 'hour': 9, 'minute': 9,
        'place_name': 'Los Angeles, California, USA',
        'latitude': 34.05, 'longitude': -118.24, 'timezone_offset': -7,  # PDT
    },
    'arnold_schwarzenegger': {
        'name': 'Arnold Schwarzenegger',
        'year': 1947, 'month': 7, 'day': 30, 'hour': 4, 'minute': 10,
        'place_name': 'Graz, Austria',
        'latitude': 47.07, 'longitude': 15.44, 'timezone_offset': 1,
    },
    'martha_stewart': {
        'name': 'Martha Stewart',
        'year': 1941, 'month': 8, 'day': 3, 'hour': 13, 'minute': 33,
        'place_name': 'Jersey City, New Jersey, USA',
        'latitude': 40.73, 'longitude': -74.08, 'timezone_offset': -4,  # EDT
    },

    # ──────────── Sports ────────────
    'muhammad_ali': {
        'name': 'Muhammad Ali',
        'year': 1942, 'month': 1, 'day': 17, 'hour': 18, 'minute': 35,
        'place_name': 'Louisville, Kentucky, USA',
        'latitude': 38.25, 'longitude': -85.76, 'timezone_offset': -6,
    },
    'tiger_woods': {
        'name': 'Tiger Woods',
        'year': 1975, 'month': 12, 'day': 30, 'hour': 22, 'minute': 50,
        'place_name': 'Long Beach, California, USA',
        'latitude': 33.77, 'longitude': -118.19, 'timezone_offset': -8,
    },
    'ayrton_senna': {
        'name': 'Ayrton Senna',
        'year': 1960, 'month': 3, 'day': 21, 'hour': 2, 'minute': 35,
        'place_name': 'Sao Paulo, Brazil',
        'latitude': -23.55, 'longitude': -46.63, 'timezone_offset': -3,
    },
    'lance_armstrong': {
        'name': 'Lance Armstrong',
        'year': 1971, 'month': 9, 'day': 18, 'hour': 12, 'minute': 0,  # noon chart
        'place_name': 'Plano, Texas, USA',
        'latitude': 33.02, 'longitude': -96.70, 'timezone_offset': -5,  # CDT
    },
    'oj_simpson': {
        'name': 'O. J. Simpson',
        'year': 1947, 'month': 7, 'day': 9, 'hour': 8, 'minute': 8,
        'place_name': 'San Francisco, California, USA',
        'latitude': 37.77, 'longitude': -122.42, 'timezone_offset': -7,  # PDT
    },

    # ──────────── Business / Tech ────────────
    'bill_gates': {
        'name': 'Bill Gates',
        'year': 1955, 'month': 10, 'day': 28, 'hour': 22, 'minute': 0,
        'place_name': 'Seattle, Washington, USA',
        'latitude': 47.61, 'longitude': -122.33, 'timezone_offset': -8,
    },
    'jeff_bezos': {
        'name': 'Jeff Bezos',
        'year': 1964, 'month': 1, 'day': 12, 'hour': 12, 'minute': 0,  # noon chart
        'place_name': 'Albuquerque, New Mexico, USA',
        'latitude': 35.08, 'longitude': -106.65, 'timezone_offset': -7,
    },
    'mark_zuckerberg': {
        'name': 'Mark Zuckerberg',
        'year': 1984, 'month': 5, 'day': 14, 'hour': 14, 'minute': 39,  # speculative
        'place_name': 'White Plains, New York, USA',
        'latitude': 41.03, 'longitude': -73.77, 'timezone_offset': -4,  # EDT
    },
    'warren_buffett': {
        'name': 'Warren Buffett',
        'year': 1930, 'month': 8, 'day': 30, 'hour': 15, 'minute': 0,
        'place_name': 'Omaha, Nebraska, USA',
        'latitude': 41.26, 'longitude': -95.94, 'timezone_offset': -6,
    },
    'bernie_madoff': {
        'name': 'Bernie Madoff',
        'year': 1938, 'month': 4, 'day': 29, 'hour': 13, 'minute': 50,
        'place_name': 'Queens, New York, USA',
        'latitude': 40.73, 'longitude': -73.79, 'timezone_offset': -4,  # EDT
    },

    # ──────────── Scientists / Thinkers ────────────
    'albert_einstein': {
        'name': 'Albert Einstein',
        'year': 1879, 'month': 3, 'day': 14, 'hour': 11, 'minute': 30,
        'place_name': 'Ulm, Germany',
        'latitude': 48.40, 'longitude': 9.99, 'timezone_offset': 1,
    },

    # ──────────── VALIDATION SET (added post-development) ────────────
    'indira_gandhi': {
        'name': 'Indira Gandhi',
        'year': 1917, 'month': 11, 'day': 19, 'hour': 23, 'minute': 11,
        'place_name': 'Allahabad, India',
        'latitude': 25.43, 'longitude': 81.85, 'timezone_offset': 5.5,
    },
    'steve_jobs': {
        'name': 'Steve Jobs',
        'year': 1955, 'month': 2, 'day': 24, 'hour': 19, 'minute': 15,
        'place_name': 'San Francisco, California, USA',
        'latitude': 37.77, 'longitude': -122.42, 'timezone_offset': -8,  # PST
    },
    'virat_kohli': {
        'name': 'Virat Kohli',
        'year': 1988, 'month': 11, 'day': 5, 'hour': 12, 'minute': 20,
        'place_name': 'Delhi, India',
        'latitude': 28.61, 'longitude': 77.21, 'timezone_offset': 5.5,
    },
    'nelson_mandela': {
        'name': 'Nelson Mandela',
        'year': 1918, 'month': 7, 'day': 18, 'hour': 12, 'minute': 0,
        'place_name': 'Mvezo, South Africa',
        'latitude': -31.97, 'longitude': 28.77, 'timezone_offset': 2,
    },
    'john_lennon': {
        'name': 'John Lennon',
        'year': 1940, 'month': 10, 'day': 9, 'hour': 18, 'minute': 30,
        'place_name': 'Liverpool, United Kingdom',
        'latitude': 53.41, 'longitude': -2.98, 'timezone_offset': 1,  # BST (wartime)
    },
    'sridevi': {
        'name': 'Sridevi',
        'year': 1963, 'month': 8, 'day': 13, 'hour': 3, 'minute': 30,
        'place_name': 'Sivakasi, Tamil Nadu, India',
        'latitude': 9.45, 'longitude': 77.80, 'timezone_offset': 5.5,
    },
    'kobe_bryant': {
        'name': 'Kobe Bryant',
        'year': 1978, 'month': 8, 'day': 23, 'hour': 17, 'minute': 0,
        'place_name': 'Philadelphia, Pennsylvania, USA',
        'latitude': 39.95, 'longitude': -75.17, 'timezone_offset': -4,  # EDT
    },
    'ratan_tata': {
        'name': 'Ratan Tata',
        'year': 1937, 'month': 12, 'day': 28, 'hour': 3, 'minute': 30,
        'place_name': 'Mumbai, India',
        'latitude': 19.08, 'longitude': 72.88, 'timezone_offset': 5.5,
    },
    'elon_musk': {
        'name': 'Elon Musk',
        'year': 1971, 'month': 6, 'day': 28, 'hour': 14, 'minute': 0,
        'place_name': 'Pretoria, South Africa',
        'latitude': -25.75, 'longitude': 28.19, 'timezone_offset': 2,
    },
    'king_charles': {
        'name': 'King Charles III',
        'year': 1948, 'month': 11, 'day': 14, 'hour': 21, 'minute': 14,
        'place_name': 'London, United Kingdom',
        'latitude': 51.51, 'longitude': -0.13, 'timezone_offset': 0,
    },
    'stephen_hawking': {
        'name': 'Stephen Hawking',
        'year': 1942, 'month': 1, 'day': 8, 'hour': 12, 'minute': 0,
        'place_name': 'Oxford, United Kingdom',
        'latitude': 51.75, 'longitude': -1.25, 'timezone_offset': 0,
    },
    'martin_luther_king': {
        'name': 'Martin Luther King Jr.',
        'year': 1929, 'month': 1, 'day': 15, 'hour': 12, 'minute': 0,
        'place_name': 'Atlanta, Georgia, USA',
        'latitude': 33.75, 'longitude': -84.39, 'timezone_offset': -5,  # EST
    },
}


# ──────────── CASE-TO-PERSON MAPPING WITH EVENT DATES ────────────
# Each case ID maps to: person slug, category, event_date (for transit computation)

CASES = {
    # BLIND TEST CASES
    'BLIND-001': {'person': 'narendra_modi',        'category': 'career_rise',  'event_date': '2014-05-16'},
    'BLIND-002': {'person': 'barack_obama',          'category': 'career_rise',  'event_date': '2008-11-04'},
    'BLIND-003': {'person': 'sachin_tendulkar',      'category': 'career_rise',  'event_date': '1989-11-15'},
    'BLIND-004': {'person': 'amitabh_bachchan',      'category': 'career_rise',  'event_date': '1975-08-15'},
    'BLIND-005': {'person': 'richard_nixon',         'category': 'career_fall',  'event_date': '1974-08-09'},
    'BLIND-006': {'person': 'rajiv_gandhi',          'category': 'death',        'event_date': '1991-05-21'},
    'BLIND-007': {'person': 'michael_jackson',       'category': 'death',        'event_date': '2009-06-25'},
    'BLIND-008': {'person': 'mahatma_gandhi',        'category': 'death',        'event_date': '1948-01-30'},
    'BLIND-009': {'person': 'elvis_presley',         'category': 'death',        'event_date': '1977-08-16'},
    'BLIND-010': {'person': 'princess_diana',        'category': 'death',        'event_date': '1997-08-31'},
    'BLIND-011': {'person': 'amitabh_bachchan',      'category': 'health',       'event_date': '1982-07-26'},
    'BLIND-012': {'person': 'princess_diana',        'category': 'marriage',     'event_date': '1981-07-29'},
    'BLIND-013': {'person': 'bill_gates',            'category': 'career_rise',  'event_date': '1986-03-13'},
    'BLIND-014': {'person': 'jeff_bezos',            'category': 'career_rise',  'event_date': '1994-07-05'},
    'BLIND-015': {'person': 'albert_einstein',       'category': 'career_rise',  'event_date': '1921-11-09'},
    'BLIND-016': {'person': 'muhammad_ali',          'category': 'career_rise',  'event_date': '1964-02-25'},
    'BLIND-017': {'person': 'margaret_thatcher',     'category': 'career_rise',  'event_date': '1979-05-04'},
    'BLIND-018': {'person': 'donald_trump',          'category': 'career_rise',  'event_date': '2016-11-08'},
    'BLIND-019': {'person': 'oprah_winfrey',         'category': 'career_rise',  'event_date': '1986-09-08'},
    'BLIND-020': {'person': 'winston_churchill',     'category': 'career_rise',  'event_date': '1940-05-10'},
    'BLIND-021': {'person': 'swami_vivekananda',     'category': 'career_rise',  'event_date': '1893-09-11'},
    'BLIND-022': {'person': 'jawaharlal_nehru',      'category': 'career_rise',  'event_date': '1947-08-15'},
    'BLIND-023': {'person': 'dhirubhai_ambani',      'category': 'wealth',       'event_date': '1977-11-10'},
    'BLIND-024': {'person': 'atal_bihari_vajpayee',  'category': 'career_rise',  'event_date': '1998-03-19'},
    'BLIND-025': {'person': 'jfk',                   'category': 'death',        'event_date': '1963-11-22'},
    'BLIND-026': {'person': 'marilyn_monroe',        'category': 'death',        'event_date': '1962-08-04'},
    'BLIND-027': {'person': 'bruce_lee',             'category': 'death',        'event_date': '1973-07-20'},
    'BLIND-028': {'person': 'ayrton_senna',          'category': 'death',        'event_date': '1994-05-01'},
    'BLIND-029': {'person': 'abraham_lincoln',       'category': 'death',        'event_date': '1865-04-15'},
    'BLIND-030': {'person': 'yuvraj_singh',          'category': 'health',       'event_date': '2011-02-01'},
    'BLIND-031': {'person': 'arnold_schwarzenegger', 'category': 'health',       'event_date': '1997-04-01'},
    'BLIND-032': {'person': 'angelina_jolie',        'category': 'health',       'event_date': '2013-05-14'},
    'BLIND-033': {'person': 'rajinikanth',           'category': 'health',       'event_date': '2016-05-01'},
    'BLIND-034': {'person': 'aishwarya_rai',         'category': 'marriage',     'event_date': '2007-04-20'},
    'BLIND-035': {'person': 'jfk',                   'category': 'marriage',     'event_date': '1953-09-12'},
    'BLIND-036': {'person': 'elizabeth_taylor',      'category': 'marriage',     'event_date': '1964-03-15'},
    'BLIND-037': {'person': 'mark_zuckerberg',       'category': 'wealth',       'event_date': '2012-05-18'},
    'BLIND-038': {'person': 'warren_buffett',        'category': 'wealth',       'event_date': '1990-01-01'},
    'BLIND-039': {'person': 'oprah_winfrey',         'category': 'wealth',       'event_date': '2003-02-26'},
    'BLIND-040': {'person': 'mukesh_ambani',         'category': 'wealth',       'event_date': '2020-07-15'},
    'BLIND-041': {'person': 'donald_trump',          'category': 'career_fall',  'event_date': '2019-12-18'},
    'BLIND-042': {'person': 'bill_clinton',          'category': 'career_fall',  'event_date': '1998-12-19'},
    'BLIND-043': {'person': 'tiger_woods',           'category': 'career_fall',  'event_date': '2009-11-27'},
    'BLIND-044': {'person': 'martha_stewart',        'category': 'career_fall',  'event_date': '2004-03-05'},
    'BLIND-045': {'person': 'pv_narasimha_rao',      'category': 'career_fall',  'event_date': '1996-05-10'},
    'BLIND-046': {'person': 'mussolini',             'category': 'career_fall',  'event_date': '1943-07-25'},
    'BLIND-047': {'person': 'sanjay_gandhi',         'category': 'career_fall',  'event_date': '1977-03-20'},
    'BLIND-048': {'person': 'amitabh_bachchan',      'category': 'career_fall',  'event_date': '1997-01-01'},
    'BLIND-049': {'person': 'jayalalithaa',          'category': 'career_fall',  'event_date': '2014-09-27'},

    # ADVERSARIAL CASES
    'ADV-001': {'person': 'donald_trump',       'category': 'career_rise',  'event_date': '2016-11-08'},
    'ADV-002': {'person': 'marilyn_monroe',     'category': 'death',        'event_date': '1962-08-04'},
    'ADV-003': {'person': 'muhammad_ali',       'category': 'career_rise',  'event_date': '1964-02-25'},
    'ADV-004': {'person': 'warren_buffett',     'category': 'wealth',       'event_date': '1990-01-01'},
    'ADV-005': {'person': 'tiger_woods',        'category': 'career_fall',  'event_date': '2009-11-27'},
    'ADV-006': {'person': 'jfk',               'category': 'death',        'event_date': '1963-11-22'},
    'ADV-007': {'person': 'sanjay_dutt',        'category': 'career_fall',  'event_date': '1993-04-19'},
    'ADV-008': {'person': 'jayalalithaa',       'category': 'career_rise',  'event_date': '2015-05-11'},
    'ADV-009': {'person': 'whitney_houston',    'category': 'death',        'event_date': '2012-02-11'},
    'ADV-010': {'person': 'benazir_bhutto',     'category': 'death',        'event_date': '2007-12-27'},
    'ADV-011': {'person': 'lance_armstrong',    'category': 'career_fall',  'event_date': '2012-08-24'},
    'ADV-012': {'person': 'oj_simpson',         'category': 'career_fall',  'event_date': '1995-06-17'},
    'ADV-013': {'person': 'bernie_madoff',      'category': 'career_fall',  'event_date': '2009-03-12'},

    # VALIDATION CASES (added post-development, never used for tuning)
    'VAL-001': {'person': 'indira_gandhi',       'category': 'career_rise',  'event_date': '1966-01-24'},
    'VAL-002': {'person': 'steve_jobs',          'category': 'career_rise',  'event_date': '1997-07-09'},
    'VAL-003': {'person': 'virat_kohli',         'category': 'career_rise',  'event_date': '2015-01-06'},
    'VAL-004': {'person': 'nelson_mandela',      'category': 'career_rise',  'event_date': '1994-05-10'},
    'VAL-005': {'person': 'john_lennon',         'category': 'death',        'event_date': '1980-12-08'},
    'VAL-006': {'person': 'sridevi',             'category': 'death',        'event_date': '2018-02-24'},
    'VAL-007': {'person': 'kobe_bryant',         'category': 'death',        'event_date': '2020-01-26'},
    'VAL-008': {'person': 'ratan_tata',          'category': 'wealth',       'event_date': '2007-10-01'},
    'VAL-009': {'person': 'elon_musk',           'category': 'wealth',       'event_date': '2020-07-01'},
    'VAL-010': {'person': 'king_charles',        'category': 'marriage',     'event_date': '1981-07-29'},
    'VAL-011': {'person': 'stephen_hawking',     'category': 'health',       'event_date': '1963-01-01'},
    'VAL-012': {'person': 'martin_luther_king',  'category': 'death',        'event_date': '1968-04-04'},
    'VAL-013': {'person': 'indira_gandhi',       'category': 'death',        'event_date': '1984-10-31'},
}


def get_birth_data(case_id: str) -> dict | None:
    """Get birth data for a test case ID. Returns None if not found."""
    case = CASES.get(case_id)
    if not case:
        return None
    person = case['person']
    birth = BIRTH_DATA.get(person)
    if not birth:
        return None
    return {
        **birth,
        'event_date': case.get('event_date'),
        'category': case.get('category'),
    }
