"""Tests for server.py: independent baselines, composure rules, and the opt-in
home Wi-Fi (--lan) security model. No camera is opened and no network is used."""
import pytest

import server
from server import Baseline, MetricBaseline, Pairing, create_app, evaluate_composure


# ---------------------------------------------------------------- baselines + composure

def test_elapsed_time_alone_never_makes_a_baseline_ready():
    m = MetricBaseline()
    m.add(0.0, 70.0)
    for i in range(1, 200):
        m.add(i * 0.5, None)
    assert not m.ready


def test_ready_after_60_s_with_30_s_valid():
    m = MetricBaseline()
    for i in range(0, 121):
        m.add(i * 0.5, 70.0)
    assert m.ready and m.mean() == 70.0


def test_half_coverage_over_60_s_is_ready():
    m = MetricBaseline()
    for i in range(0, 121):
        m.add(i * 0.5, 72.0 if i % 2 == 0 else None)
    assert m.ready


def test_mean_hidden_until_ready():
    m = MetricBaseline()
    for i in range(0, 50):
        m.add(i * 0.5, 70.0)
    assert m.mean() is None


def test_weak_heart_does_not_block_other_baselines():
    b = Baseline()
    for i in range(0, 130):
        b.add(i * 0.5, heart=None, breath=12.0, blink=17.0)
    assert b.metrics["breath"].ready and b.metrics["blink"].ready
    assert not b.metrics["heart"].ready and not b.ready


def test_composure_states():
    assert evaluate_composure(None, None, None, 15, 12, 70)["state"] == "calibrating"
    assert evaluate_composure(None, None, 68.0, None, None, 70.0)["state"] == "insufficient"
    assert evaluate_composure(None, 12.0, 68.0, None, 12.5, 70.0)["state"] == "calm"
    c = evaluate_composure(None, 12.0, 68.0, None, 15.5, 80.0)
    assert c["state"] == "elevated" and c["breath_high"] and c["hr_high"]
    assert evaluate_composure(17.0, None, None, 8.0, None, None)["state"] == "elevated"
    c = evaluate_composure(2.0, 12.0, 68.0, 0.0, 12.0, 70.0)
    assert c["blink_baseline_too_low"] and "blink" not in c["used"]


# ---------------------------------------------------------------- home Wi-Fi mode

class FakeShared:
    source = "browser"

    def get_readings(self):
        return {"running": True}

    def start_session(self):
        return 1

    def current_session(self):
        return 1


LAN_IP = "192.168.1.20"
PORT = 5001
ORIGIN = f"https://{LAN_IP}:{PORT}"


@pytest.fixture()
def lan_client():
    lan = {"ip": LAN_IP, "pairing": Pairing()}
    web = create_app(FakeShared(), PORT, None, lan)
    web.testing = True
    client = web.test_client()
    return client, lan["pairing"]


def post_pair(client, code, ip="192.168.1.30"):
    return client.post("/api/pair", json={"code": code}, base_url=ORIGIN,
                       headers={"Origin": ORIGIN, "X-Cuore-Client": "1"},
                       environ_base={"REMOTE_ADDR": ip})


def test_pages_load_but_data_needs_pairing(lan_client):
    client, _ = lan_client
    assert client.get("/app", base_url=ORIGIN).status_code == 200
    assert client.get("/api/readings", base_url=ORIGIN).status_code == 401
    assert client.get("/video", base_url=ORIGIN).status_code == 401


def test_wrong_code_is_refused(lan_client):
    client, _ = lan_client
    r = post_pair(client, "AAAA-AAAA")
    assert r.status_code == 403 and "Set-Cookie" not in r.headers


def test_right_code_pairs_with_a_strict_cookie(lan_client):
    client, pairing = lan_client
    r = post_pair(client, pairing.display.lower())          # case and dash don't matter
    assert r.status_code == 200
    cookie = r.headers["Set-Cookie"]
    assert "HttpOnly" in cookie and "Secure" in cookie and "SameSite=Strict" in cookie
    assert pairing.code not in cookie                      # the cookie is a token, not the code
    assert client.get("/api/readings", base_url=ORIGIN).status_code == 200


def test_pairing_is_rate_limited(lan_client):
    client, pairing = lan_client
    for _ in range(server.PAIR_FAILS_PER_MIN):
        assert post_pair(client, "WRONGCODE").status_code == 403
    assert post_pair(client, pairing.code).status_code == 429   # even the right code, once locked


def test_pairing_needs_same_origin_and_client_header(lan_client):
    client, pairing = lan_client
    r = client.post("/api/pair", json={"code": pairing.code}, base_url=ORIGIN, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    r = client.post("/api/pair", json={"code": pairing.code}, base_url=ORIGIN, headers={"Origin": ORIGIN})
    assert r.status_code == 403


def test_other_hosts_are_refused_in_lan_mode(lan_client):
    client, _ = lan_client
    assert client.get("/app", base_url=f"https://evil.example:{PORT}").status_code == 403
    assert client.get("/app", base_url=f"http://127.0.0.1:{PORT}").status_code == 403


def test_default_mode_is_unchanged():
    web = create_app(FakeShared(), PORT, None)
    web.testing = True
    client = web.test_client()
    base = f"http://127.0.0.1:{PORT}"
    assert client.get("/api/readings", base_url=base).status_code == 200      # no pairing needed
    assert client.post("/api/pair", json={}, base_url=base,
                       headers={"Origin": base, "X-Cuore-Client": "1"}).status_code == 404
    assert client.get("/app", base_url=f"http://{LAN_IP}:{PORT}").status_code == 403   # loopback only


def test_pairing_codes_are_random_and_unambiguous():
    codes = {Pairing().code for _ in range(200)}
    assert len(codes) == 200
    assert all(len(c) == server.PAIR_LEN and not set(c) & set("01OIL") for c in codes)
