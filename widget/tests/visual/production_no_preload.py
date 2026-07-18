from playwright.sync_api import sync_playwright

from capture_widget import BASE_URL


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 400, "height": 240})
        page.set_default_timeout(5_000)
        page.goto(BASE_URL, wait_until="networkidle")
        page.locator(".widget-shell[data-status='offline']").wait_for(state="visible")
        page.locator(".state-view--error").wait_for(state="visible")
        assert page.locator(".source-badge--preview").count() == 0
        assert "12.85M" not in page.locator("body").inner_text()
        browser.close()
    print("production-no-preload-offline-pass")


if __name__ == "__main__":
    main()
