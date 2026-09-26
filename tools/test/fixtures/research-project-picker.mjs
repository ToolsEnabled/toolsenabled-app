// Shared browser navigation for project controls outside the benchmark module.
export async function openResearchProject(page, { account = false } = {}) {
  const button = page.locator('[data-projects-btn]')
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click()
  if (account) {
    const details = page.locator('[data-account-project-options]')
    if (!await details.evaluate(node => node.open)) await details.locator('summary').click()
  }
}
