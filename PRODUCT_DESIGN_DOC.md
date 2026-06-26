# InkVoucher — Product Design Doc

**Author:** Antigravity
**Status:** Draft v0.2
**Last updated:** 2026-06-22
**One-liner:** Keep the tactile feel of handwriting paper payment vouchers with automatic arithmetic calculations and persistent digital records.

---

## 1. The user & the moment

- **Who:** A staff member at a busy construction materials shop or wholesale boutique who needs to quickly issue payment vouchers. They want the speed and flexibility of handwriting long, technical item names (e.g., "1/2 inch Galvanized Steel Pipe Threaded") but frequently make math errors when manually calculating line item amounts and grand totals.
- **When:** A contractor or customer is checking out. The staff member wants to write down the description of the items, input the quantity and price, and have the software handle all calculations instantly.
- **Why now:** Manual arithmetic on traditional paper books leads to cash discrepancies and accounting errors, while fully digital POS databases require slow typing, item catalog searches, and configuration that doesn't fit high-velocity, custom wholesale checkouts.

## 2. The contract (I/O)

- **Input:** 
  - **Header:** Date picker, Payment Method selection (Cash, Bank Transfer, PayNow).
  - **Line Items:** For each of the 8 voucher rows, a handwritten description (Apple Pencil drawing canvas), a numeric Quantity input, and a numeric Price input.
- **Output:** 
  - **Calculations:** Auto-computed line item amounts (`Qty × Price`) and an auto-computed grand total.
  - **Record:** A structured digital ledger entry with a sequential voucher ID, date, payment method, numeric amounts, grand total, and a high-resolution merged image of the handwritten voucher.
- **The loop:** Open app → Draw item descriptions → Enter Qty/Price → View auto-calculated total → Select payment method → Tap "Save" → Ledger updates.

## 3. The magical moment

> "I just scribbled the item descriptions like I would on paper, entered the price and quantity, and the voucher instantly calculated the totals for me. No calculator, no math mistakes, and the record is saved digitally."

## 4. Scope: what we ARE building (v1)

- **Calculated Paper Table:** A paper-styled payment voucher with 8 rows where the "Particulars" column is a drawing canvas, and the "Qty" and "Price" columns are interactive numeric input boxes.
- **Automatic Arithmetic Engine:** Real-time calculation of `Quantity × Price` for each row, and a grand `Total Amount` summation block at the bottom of the voucher.
- **Header Controls:** Auto-incrementing Voucher Number, Date picker, and Payment Method selector supporting Cash, Bank Transfer, and PayNow.
- **Drawing & Erasing Tools:** A floating toolbar containing Pencil Tool, Eraser Tool, Clear Particulars Canvas (per row or all), and a global Clear Entire Voucher button.
- **Voucher Ledger & History:** Sidebar directory with a search filter (search by ID or date) and detailed review overlay showing the saved voucher with print/void options.

## 5. Scope: what we are NOT building

- **No OCR / handwriting-to-text conversion** — Descriptions remain visual ink layers.
- **No inventory management** — No inventory decrementing or stock lookup.
- **No accounting system integration** — No sync with QuickBooks, Xero, or other ledger APIs.
- **No customer management** — No customer directories, accounts, or profiles.
- **No multi-branch synchronization** — Data is saved locally in IndexedDB on the device.
- **No financial reporting dashboards** — No graphs or spreadsheet exports.
- **No AI-powered categorization** — No automatic classification of items.

## 6. The signature detail

The voucher design mimics a yellow carbon-copy page. Each line's drawing canvas features ruled lines that match the paper aesthetic. When a user fills in the Qty and Price fields, the computed Amount fades in with a blue "printed dot-matrix ink" text effect. Tapping "Save" plays a paper rip sound and slides the sheet off-screen, fading in a new one.

## 7. Success: how we know it worked

- **Primary:** Zero manual calculation error corrections needed post-save. Users complete checkout in <30 seconds per voucher on average.
- **What we're NOT measuring:** App downloads, cloud sync speed, text search queries.

## 8. Open questions

- [ ] **Row height scaling:** How do we optimize the row canvas size for tablet stylus input? (Ensure row heights are at least 48px to allow legible handwriting).
- [ ] **Print/Export styling:** Should the exported PNG include the numeric input borders, or render clean text over the lines? (Render clean text over the voucher template to look like a printed duplicate).

## 9. Handoff

- **For UX:** Row drawing must be extremely responsive. Transitions between inputs and stylus drawing should feel seamless.
- **For Eng:** Coordinate event scaling on multiple independent row canvases, merging them together with text inputs into a single high-resolution export PNG.
