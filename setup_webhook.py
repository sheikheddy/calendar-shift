#!/usr/bin/env python3
"""
Set up Oura Webhook Subscription

Creates a webhook subscription to receive sleep data notifications.

Usage:
    python setup_webhook.py --url https://your-tunnel-url.trycloudflare.com/webhook/oura
    python setup_webhook.py --list
    python setup_webhook.py --delete SUBSCRIPTION_ID
"""

import argparse
import json
import os
import requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OURA_CREDENTIALS_FILE = os.path.join(SCRIPT_DIR, 'oura_credentials.json')
OURA_TOKEN_FILE = os.path.join(SCRIPT_DIR, 'oura_token.json')

OURA_API_BASE = 'https://api.ouraring.com/v2'
VERIFICATION_TOKEN = 'calendar-shift-webhook-secret'


def load_credentials():
    """Load Oura OAuth credentials."""
    with open(OURA_CREDENTIALS_FILE, 'r') as f:
        return json.load(f)


def load_token():
    """Load Oura OAuth token."""
    with open(OURA_TOKEN_FILE, 'r') as f:
        return json.load(f)


def get_headers():
    """Get authorization headers with client credentials."""
    credentials = load_credentials()
    token = load_token()
    return {
        'Authorization': f'Bearer {token["access_token"]}',
        'x-client-id': credentials['client_id'],
        'x-client-secret': credentials['client_secret'],
        'Content-Type': 'application/json'
    }


def list_subscriptions():
    """List existing webhook subscriptions."""
    response = requests.get(
        f'{OURA_API_BASE}/webhook/subscription',
        headers=get_headers()
    )

    if response.status_code == 200:
        data = response.json()
        print("Current webhook subscriptions:")

        # Handle both list and dict response formats
        subs = data if isinstance(data, list) else data.get('data', [])

        if not subs:
            print("  (none)")
        for sub in subs:
            print(f"  ID: {sub.get('id')}")
            print(f"    URL: {sub.get('callback_url')}")
            print(f"    Data type: {sub.get('data_type')}")
            print(f"    Event type: {sub.get('event_type')}")
            print(f"    Expiration: {sub.get('expiration_time')}")
            print()
    else:
        print(f"Error listing subscriptions: {response.status_code}")
        print(response.text)


def create_subscription(callback_url: str):
    """Create a webhook subscription for sleep data."""
    credentials = load_credentials()

    payload = {
        'callback_url': callback_url,
        'verification_token': VERIFICATION_TOKEN,
        'event_type': 'create',
        'data_type': 'sleep'
    }

    print(f"Creating webhook subscription...")
    print(f"  Callback URL: {callback_url}")
    print(f"  Data type: sleep")
    print(f"  Event type: create")

    response = requests.post(
        f'{OURA_API_BASE}/webhook/subscription',
        headers=get_headers(),
        json=payload
    )

    if response.status_code in (200, 201):
        result = response.json()
        print(f"\nSuccess! Subscription created:")
        print(f"  ID: {result.get('id')}")
        print(f"  Expiration: {result.get('expiration_time')}")
        return result
    else:
        print(f"\nError creating subscription: {response.status_code}")
        print(response.text)
        return None


def delete_subscription(subscription_id: str):
    """Delete a webhook subscription."""
    response = requests.delete(
        f'{OURA_API_BASE}/webhook/subscription/{subscription_id}',
        headers=get_headers()
    )

    if response.status_code in (200, 204):
        print(f"Subscription {subscription_id} deleted.")
    else:
        print(f"Error deleting subscription: {response.status_code}")
        print(response.text)


def main():
    parser = argparse.ArgumentParser(description='Manage Oura webhook subscriptions')
    parser.add_argument('--url', type=str, help='Callback URL for new subscription')
    parser.add_argument('--list', action='store_true', help='List existing subscriptions')
    parser.add_argument('--delete', type=str, help='Delete subscription by ID')
    args = parser.parse_args()

    if args.list:
        list_subscriptions()
    elif args.delete:
        delete_subscription(args.delete)
    elif args.url:
        create_subscription(args.url)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
