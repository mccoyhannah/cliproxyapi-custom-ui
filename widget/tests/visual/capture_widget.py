import json
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = "http://127.0.0.1:5173"
OUTPUT_DIR = Path(
    r"D:\Tools\Cache\agent-tasks\webapp-testing\cpa-token-pulse-final-20260717"
)


def usage(total=0, requests=0, estimated=0.0, unpriced=0):
    input_tokens = round(total * 0.82)
    output_tokens = total - input_tokens
    cached_tokens = round(input_tokens * 0.61)
    reasoning_tokens = round(output_tokens * 0.42)
    priced_tokens = max(0, total - unpriced)
    return {
        "fromMs": 1784131200000,
        "toMs": 1784217600000,
        "requests": requests,
        "inputTokens": input_tokens,
        "cachedInputTokens": cached_tokens,
        "outputTokens": output_tokens,
        "reasoningTokens": reasoning_tokens,
        "totalTokens": total,
        "estimatedUsd": estimated,
        "pricedTokens": priced_tokens,
        "unpricedTokens": unpriced,
        "pricedRequests": max(0, requests - (2 if unpriced else 0)),
        "unpricedRequests": 2 if unpriced else 0,
    }


def snapshot(status="live", total=12_846_320, unpriced=0, message_code=None):
    now = int(time.time() * 1000)
    today = usage(total, 184, None if total and total == unpriced else 28.4186, unpriced)
    live_points = [
        {
            "startMs": now - (59 - index) * 60_000,
            "requests": (index % 5) + 1,
            "totalTokens": 18_000 + ((index * 37) % 9) * 7_400,
            "estimatedUsd": 0.03 + index * 0.0012,
        }
        for index in range(60)
    ]
    return {
        "version": 1,
        "computedAt": "2026-07-16T10:40:00.000Z",
        "source": {
            "status": status,
            "installDir": r"D:\CLIProxyAPI",
            "collectorVersion": "1.0.0",
            "parserVersion": "1.0.0",
            "pricingVersion": "1.0.0",
            "ledgerGeneratedAt": "2026-07-16T10:39:58.000Z",
            "ledgerCoverageStartMs": 1778357733000,
            "ledgerCoverageEndMs": now,
            "latestRequestAtMs": now - 2_000 if total else None,
            "lastSuccessfulScanAtMs": now - 1_000 if status not in ("offline", "error") else None,
            "lastReconcileAtMs": now - 4_000,
            "pendingFiles": 2 if status == "degraded" else 0,
            "parseErrors": 1 if status == "degraded" else 0,
            "unsupportedFiles": 3 if status == "degraded" else 0,
            "possibleCoverageGap": status in ("degraded", "offline", "error"),
            "messageCode": message_code,
        },
        "statusCounts": {
            "available": 13842 if total else 0,
            "pending": 2 if status == "degraded" else 0,
            "unreported": 38 if status == "degraded" else 0,
            "ambiguous": 1 if status == "degraded" else 0,
            "parseError": 1 if status == "degraded" else 0,
            "unsupported": 3 if status == "degraded" else 0,
        },
        "periods": {
            "today": today,
            "rolling24h": usage(total * 2, 351, 54.8072, unpriced * 2),
            "rolling7d": usage(total * 11, 2158, 312.4021, unpriced * 4),
            "month": usage(total * 26, 5124, 726.1954, unpriced * 8),
            "ledgerCoverage": usage(total * 84, 13842, 2348.9237, unpriced * 12),
        },
        "trend60m": live_points if total else [],
        "topModels": [
            {
                "model": "gpt-5.5-codex",
                "requests": 92,
                "inputTokens": 6_912_000,
                "cachedInputTokens": 4_622_000,
                "outputTokens": 604_000,
                "reasoningTokens": 281_000,
                "totalTokens": 7_516_000,
                "estimatedUsd": 17.2401,
                "pricedTokens": 7_516_000,
                "unpricedTokens": 0,
                "pricedRequests": 92,
                "unpricedRequests": 0,
            },
            {
                "model": "gpt-5.6-sol",
                "requests": 56,
                "inputTokens": 4_082_000,
                "cachedInputTokens": 2_281_000,
                "outputTokens": 493_000,
                "reasoningTokens": 214_000,
                "totalTokens": 4_575_000,
                "estimatedUsd": None,
                "pricedTokens": 0,
                "unpricedTokens": 4_575_000,
                "pricedRequests": 0,
                "unpricedRequests": 56,
            },
        ],
        "recentModels": (
            [
                {
                    "model": "gpt-5.6-sol",
                    "timestampMs": now - 2_000,
                    "totalTokens": 150_281,
                    "estimatedUsd": None,
                },
                {
                    "model": "gpt-image-2-codex",
                    "timestampMs": now - 6 * 60_000,
                    "totalTokens": 86_420,
                    "estimatedUsd": 0.1432,
                },
                {
                    "model": "gpt-5.5",
                    "timestampMs": now - 11 * 60_000,
                    "totalTokens": 64_930,
                    "estimatedUsd": 0.3842,
                },
            ]
            if total
            else []
        ),
        "latestRequest": (
            {
                "model": "gpt-5.6-sol",
                "timestampMs": now - 2_000,
                "status": "unpriced",
                "totalTokens": 150_281,
                "estimatedUsd": None,
            }
            if total
            else None
        ),
    }


def api_script(value, expanded=False):
    payload = json.dumps(value, ensure_ascii=False)
    settings = json.dumps(
        {"alwaysOnTop": True, "expanded": expanded, "pricingOverrides": []},
        ensure_ascii=False,
    )
    return f"""
      (() => {{
        const snapshot = {payload};
        snapshot.computedAt = new Date(Date.now() + 1000).toISOString();
        let settings = {settings};
        const settingsListeners = new Set();
        window.__emitWidgetSettings = (next) => {{
          settings = next;
          settingsListeners.forEach((listener) => listener(next));
        }};
        window.cpaWidget = {{
          getSnapshot: async () => snapshot,
          subscribe: () => () => undefined,
          subscribeSettings: (listener) => {{
            settingsListeners.add(listener);
            return () => settingsListeners.delete(listener);
          }},
          getSettings: async () => settings,
          saveSettings: async (next) => (settings = next),
          setWindowMode: async () => undefined,
          setAlwaysOnTop: async () => undefined,
          hideToTray: async () => undefined,
          quit: async () => undefined,
        }};
      }})();
    """


def collect_metrics(page, name, console_errors):
    metrics = page.evaluate(
        """
        () => {
          const shell = document.querySelector('.widget-shell');
          const overflowing = [...document.querySelectorAll('*')]
            .filter((node) => node instanceof HTMLElement)
            .filter((node) => node.scrollWidth > node.clientWidth + 1)
            .filter((node) => getComputedStyle(node).overflowX === 'visible')
            .slice(0, 20)
            .map((node) => ({
              tag: node.tagName,
              className: node.className,
              scrollWidth: node.scrollWidth,
              clientWidth: node.clientWidth,
            }));
          const tinyText = [...document.querySelectorAll('span, small, p, b, strong, button, h1, h2')]
            .filter((node) => node instanceof HTMLElement)
            .filter((node) => node.textContent?.trim())
            .filter((node) => {
              const rect = node.getBoundingClientRect();
              const style = getComputedStyle(node);
              return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
            })
            .filter((node) => Number.parseFloat(getComputedStyle(node).fontSize) < 10)
            .slice(0, 30)
            .map((node) => ({
              tag: node.tagName,
              className: node.className,
              fontSize: getComputedStyle(node).fontSize,
              text: node.textContent.trim().slice(0, 80),
            }));
          return {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            documentScrollWidth: document.documentElement.scrollWidth,
            documentScrollHeight: document.documentElement.scrollHeight,
            shell: shell ? shell.getBoundingClientRect().toJSON() : null,
            overflowing,
            tinyText,
            coverageText:
              document.querySelector('.coverage-line > span:last-child')?.textContent?.trim() ?? null,
          };
        }
        """
    )
    metrics["name"] = name
    metrics["consoleErrors"] = console_errors
    return metrics


def capture(browser, name, width, height, value=None, expanded=False, scale=1.0):
    context = browser.new_context(
        viewport={"width": width, "height": height},
        device_scale_factor=scale,
        reduced_motion="reduce" if name.endswith("reduced-motion") else "no-preference",
    )
    page = context.new_page()
    console_errors = []

    def record_console(message):
        if message.type != "error":
            return
        if "frame-ancestors' is ignored when delivered via a <meta>" in message.text:
            return
        console_errors.append(message.text)

    page.on("console", record_console)
    page.on("pageerror", lambda error: console_errors.append(str(error)))
    if value is not None:
        page.add_init_script(script=api_script(value, expanded))
    page.goto(BASE_URL, wait_until="networkidle")
    page.locator(".widget-shell").wait_for(state="visible")
    page.wait_for_timeout(350)
    image_path = OUTPUT_DIR / f"{name}.png"
    page.screenshot(path=str(image_path), full_page=False)
    result = collect_metrics(page, name, console_errors)
    result["screenshot"] = str(image_path)
    result["deviceScaleFactor"] = scale
    context.close()
    return result


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    empty = snapshot("loading", 0)
    offline = snapshot("offline", 0, message_code="ledger-unreadable")
    error = snapshot("error", 0, message_code="collector-worker-error")
    live = snapshot("live")
    degraded = snapshot("degraded")
    unpriced = snapshot("live", total=12_846_320, unpriced=4_575_000)
    near_complete = snapshot("live", total=12_846_320, unpriced=1)

    scenarios = [
        ("compact-live-100", 380, 220, live, False, 1.0),
        ("compact-live-125", 380, 220, live, False, 1.25),
        ("compact-live-150", 380, 220, live, False, 1.5),
        ("compact-loading", 380, 220, empty, False, 1.0),
        ("compact-degraded", 380, 220, degraded, False, 1.0),
        ("compact-unpriced", 380, 220, unpriced, False, 1.0),
        ("compact-offline", 380, 220, offline, False, 1.0),
        ("compact-error", 380, 220, error, False, 1.0),
        ("expanded-live-100", 460, 600, live, True, 1.0),
        ("expanded-live-125", 460, 600, live, True, 1.25),
        ("expanded-live-150", 460, 600, live, True, 1.5),
        ("expanded-unpriced", 460, 600, unpriced, True, 1.0),
        ("expanded-near-complete", 460, 600, near_complete, True, 1.0),
        ("expanded-degraded", 460, 600, degraded, True, 1.0),
        ("expanded-reduced-motion", 460, 600, live, True, 1.0),
    ]

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        results = [capture(browser, *scenario) for scenario in scenarios]
        browser.close()

    metrics_path = OUTPUT_DIR / "metrics.json"
    metrics_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    failures = [
        item
        for item in results
        if item["documentScrollWidth"] > item["innerWidth"]
        or item["documentScrollHeight"] > item["innerHeight"]
        or item["consoleErrors"]
        or (item["name"].startswith("expanded") and item["tinyText"])
        or (item["name"] == "expanded-near-complete" and item["coverageText"].startswith("100%"))
    ]
    print(json.dumps({"screenshots": len(results), "failures": failures}, ensure_ascii=False))
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
