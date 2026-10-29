#!/usr/bin/env python3
"""
Google Maps Scraper Runner
Integrates omkarcloud/google-maps-scraper engine with outreach-cli.
Extracts business names, phone numbers, websites, and ratings (emails come from
email_finder.py, which reads each business's own website),
then outputs structured JSON for leads integration.
"""

import sys
import os
import json
import argparse

# Add engine directory to sys.path so src module can be resolved
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ENGINE_DIR = os.path.join(SCRIPT_DIR, "engine")
if ENGINE_DIR not in sys.path:
    sys.path.insert(0, ENGINE_DIR)
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from email_finder import enrich_with_emails

def run_scraper(query, max_results=10, lang="en"):
    """
    Executes Google Maps Scraper using omkarcloud/google-maps-scraper engine
    """
    task_data = {
        'api_key': None,
        'lang': lang,
        'max_results': int(max_results),
        'enable_reviews_extraction': False,
        'max_reviews': 0,
        'reviews_sort': 'newest',
        'coordinates': '',
        'zoom_level': 14,
        'query': query,
        'links': []
    }

    print(f"[Engine] Starting Google Maps search for: \"{query}\" (limit: {max_results})...", file=sys.stderr)

    # Method 1: Run via google_maps_scraper task
    try:
        from src.gmaps import google_maps_scraper
        results = google_maps_scraper(task_data)
        if isinstance(results, dict) and "places" in results:
            return results["places"]
        if isinstance(results, list):
            return results
    except Exception as e:
        sys.stderr.write(f"[Engine] Warning: google_maps_scraper encountered {e}, trying direct scraper...\n")

    # Method 2: Direct scrape_places call
    try:
        from src import scraper
        place_data = {
            "query": query,
            "max": int(max_results),
            "lang": lang,
            "geo_coordinates": '',
            "zoom": 14,
            "links": []
        }
        res = scraper.scrape_places(place_data)
        if isinstance(res, dict) and "places" in res:
            return res["places"]
        if isinstance(res, list):
            return res
        return []
    except Exception as e2:
        sys.stderr.write(f"[Engine] Scraping Execution Error: {e2}\n")
        return []

def main():
    parser = argparse.ArgumentParser(description="Google Maps Scraper Runner")
    parser.add_argument("--query", required=True, help="Search query (e.g. 'Restaurants in DHA Lahore')")
    parser.add_argument("--max", type=int, default=10, help="Maximum number of places to scrape")
    parser.add_argument("--lang", default="en", help="Language code")
    parser.add_argument("--output", help="Optional output JSON file path")
    parser.add_argument("--no-emails", action="store_true", help="Skip scanning websites for contact emails")
    args = parser.parse_args()

    places = run_scraper(args.query, args.max, args.lang)

    if places and not args.no_emails:
        enrich_with_emails(places, log=lambda msg: print(msg, file=sys.stderr))

    output_payload = {
        "query": args.query,
        "count": len(places),
        "places": places
    }

    if args.output:
        os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(output_payload, f, indent=2, ensure_ascii=False)
        print(f"[Engine] Saved {len(places)} places to {args.output}", file=sys.stderr)

    # Print JSON output to stdout for Node.js process to consume
    print(json.dumps(output_payload, ensure_ascii=False))

if __name__ == "__main__":
    main()
