import json
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = "http://127.0.0.1:5173"
OUTPUT_DIR = Path(
    r"D:\Tools\Cache\agent-tasks\webapp-testing\cpa-token-pulse-final-20260717"
)


def geometry(page):
    return page.evaluate(
        """
        () => {
          const dialog = document.querySelector('.maintenance-dialog');
          const body = document.querySelector('.maintenance-dialog__body');
          return {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            documentScrollWidth: document.documentElement.scrollWidth,
            documentScrollHeight: document.documentElement.scrollHeight,
            dialog: dialog ? dialog.getBoundingClientRect().toJSON() : null,
            bodyClientHeight: body?.clientHeight ?? null,
            bodyScrollHeight: body?.scrollHeight ?? null,
          };
        }
        """
    )


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    console_errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 460, "height": 600}, device_scale_factor=1.25
        )
        page = context.new_page()

        def record_console(message):
            if message.type != "error":
                return
            if "frame-ancestors' is ignored when delivered via a <meta>" in message.text:
                return
            console_errors.append(message.text)

        page.on("console", record_console)
        page.goto(BASE_URL, wait_until="networkidle")

        page.get_by_role("button", name="展开详细信息", exact=True).click()
        page.get_by_role("button", name="入账并清理", exact=True).click()
        page.get_by_role("heading", name="入账并清理", exact=True).wait_for()
        page.get_by_text("预计新增 Token", exact=True).wait_for()
        preview = geometry(page)
        page.screenshot(path=OUTPUT_DIR / "maintenance-preview-125.png")

        page.get_by_role("button", name="确认入账并清理", exact=True).click()
        page.get_by_text("入账并清理完成", exact=True).wait_for()
        completed = geometry(page)
        page.screenshot(path=OUTPUT_DIR / "maintenance-completed-125.png")

        context.close()
        browser.close()

    result = {
        "preview": preview,
        "completed": completed,
        "consoleErrors": console_errors,
    }
    (OUTPUT_DIR / "maintenance-metrics.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    failures = []
    for name, value in (("preview", preview), ("completed", completed)):
        if value["documentScrollWidth"] > value["innerWidth"]:
            failures.append(f"{name}-horizontal-overflow")
        if not value["dialog"]:
            failures.append(f"{name}-missing-dialog")
    failures.extend(console_errors)
    print(json.dumps({"screenshots": 2, "failures": failures}, ensure_ascii=False))
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
