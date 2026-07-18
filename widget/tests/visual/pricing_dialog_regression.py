import argparse

from playwright.sync_api import sync_playwright

from capture_widget import BASE_URL, api_script, snapshot


def open_pricing(page):
    print("open-pricing:start", flush=True)
    page.add_init_script(script=api_script(snapshot("live", unpriced=4_575_000), expanded=True))
    page.goto(BASE_URL, wait_until="networkidle")
    print("open-pricing:loaded", flush=True)
    print(f"api-status:{page.evaluate('window.cpaWidget.getSnapshot().then(value => value.source.status)')}", flush=True)
    print(f"shell-status:{page.locator('.widget-shell').get_attribute('data-status')}", flush=True)
    page.locator(".expanded-dashboard").wait_for(state="visible")
    print(f"pricing-buttons:{page.locator('.pricing-callout .text-button').count()}", flush=True)
    page.locator(".pricing-callout .text-button").click()
    page.locator(".dialog-backdrop[role='dialog']").wait_for(state="visible")
    print("open-pricing:dialog", flush=True)


def check_typing(page):
    page.locator(".add-rule-button").click()
    pattern = page.locator(".field--pattern input")
    pattern.focus()
    page.keyboard.type("gpt-5.6-*", delay=30)
    assert pattern.input_value() == "gpt-5.6-*", pattern.input_value()
    assert pattern.evaluate("node => document.activeElement === node")


def check_focus(page):
    dialog = page.locator(".dialog-backdrop[role='dialog']")
    close = page.locator(".dialog-header .icon-button")
    close.focus()
    page.keyboard.press("Shift+Tab")
    assert dialog.evaluate("node => node.contains(document.activeElement)")
    page.keyboard.press("Escape")
    dialog.wait_for(state="detached")
    trigger = page.locator(".pricing-callout .text-button")
    assert trigger.evaluate("node => document.activeElement === node")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("case", choices=["typing", "focus"])
    args = parser.parse_args()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 520, "height": 680})
        page.set_default_timeout(5_000)
        open_pricing(page)
        if args.case == "typing":
            check_typing(page)
        else:
            check_focus(page)
        browser.close()
    print(f"pricing-dialog-{args.case}-pass")


if __name__ == "__main__":
    main()
