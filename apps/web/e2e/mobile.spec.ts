import { expect, test } from "@playwright/test";

test("the ticket comes before the book on a phone", async ({ page }) => {
  await page.goto("/terminal/ORBT");
  const ticket = await page.getByRole("heading", { name: "Place an order" }).boundingBox();
  const book = await page.getByRole("heading", { name: "Order book" }).boundingBox();
  expect(ticket && book && ticket.y < book.y).toBe(true);
});
