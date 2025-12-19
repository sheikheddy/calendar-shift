#!/usr/bin/env python3
"""
Oura Webhook Server

Receives webhook callbacks from Oura when new sleep data is available,
then triggers the calendar shift logic.

Run with: python webhook_server.py
Expose with: cloudflared tunnel --url http://localhost:5000
"""

import hashlib
import hmac
import json
import os
import subprocess
import sys
from datetime import datetime
from flask import Flask, request, jsonify

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VERIFICATION_TOKEN = os.environ.get('OURA_WEBHOOK_TOKEN', 'calendar-shift-webhook-secret')

app = Flask(__name__)


def verify_signature(payload: bytes, signature: str) -> bool:
    """Verify Oura webhook signature."""
    if not signature:
        return False
    expected = hmac.new(
        VERIFICATION_TOKEN.encode(),
        payload,
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint."""
    return jsonify({'status': 'ok', 'timestamp': datetime.now().isoformat()})


@app.route('/webhook/oura', methods=['POST'])
def oura_webhook():
    """Handle Oura webhook callbacks."""
    # Log incoming request
    print(f"\n[{datetime.now().isoformat()}] Received webhook")

    # Get signature from header
    signature = request.headers.get('X-Oura-Signature')

    # Verify signature (optional but recommended)
    # if not verify_signature(request.data, signature):
    #     print("  Invalid signature!")
    #     return jsonify({'error': 'invalid signature'}), 401

    try:
        data = request.json
        print(f"  Payload: {json.dumps(data, indent=2)}")

        event_type = data.get('event_type')
        data_type = data.get('data_type')

        print(f"  Event: {event_type}, Data type: {data_type}")

        # Trigger calendar shift when new sleep data arrives
        if data_type == 'sleep' and event_type == 'create':
            print("  New sleep data detected! Running calendar shift...")

            # Run the calendar shift script
            result = subprocess.run(
                [sys.executable, os.path.join(SCRIPT_DIR, 'calendar_shift.py')],
                capture_output=True,
                text=True,
                cwd=SCRIPT_DIR
            )

            print(f"  Script output:\n{result.stdout}")
            if result.stderr:
                print(f"  Script errors:\n{result.stderr}")

            return jsonify({
                'status': 'processed',
                'calendar_shift': result.returncode == 0
            })

        return jsonify({'status': 'ignored', 'reason': 'not sleep create event'})

    except Exception as e:
        print(f"  Error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/webhook/oura', methods=['GET'])
def oura_webhook_verify():
    """Handle Oura webhook verification challenge."""
    # Oura sends a verification challenge as query param
    challenge = request.args.get('challenge')
    if challenge:
        print(f"Verification challenge: {challenge}")
        # Return as JSON with the challenge value
        return jsonify({'challenge': challenge})
    return jsonify({'status': 'ready'})


if __name__ == '__main__':
    print("Starting Oura Webhook Server...")
    print(f"Webhook endpoint: http://localhost:5050/webhook/oura")
    print(f"Health check: http://localhost:5050/health")
    print("\nTo expose publicly, run:")
    print("  cloudflared tunnel --url http://localhost:5050")
    print("\nThen create webhook subscription with that URL + /webhook/oura")

    app.run(host='0.0.0.0', port=5050, debug=True)
