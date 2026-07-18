from playwright.sync_api import sync_playwright

from capture_widget import BASE_URL, api_script, snapshot


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 520, "height": 680})
        page.set_default_timeout(5_000)
        page.add_init_script(script=api_script(snapshot("live"), expanded=False))
        page.goto(BASE_URL, wait_until="networkidle")
        page.locator(".widget-shell--compact").wait_for(state="visible")
        page.evaluate(
            """
            window.__emitWidgetSettings({
              alwaysOnTop: false,
              expanded: true,
              pricingOverrides: [],
            })
            """
        )
        page.locator(".expanded-dashboard").wait_for(state="visible")
        assert page.locator(".widget-shell--expanded").count() == 1
        browser.close()
    print("settings-sync-pass")


if __name__ == "__main__":
    main()
