# InkVoucher — UX Design Doc

**Designer:** Antigravity
**Status:** Draft v0.2
**Last updated:** 2026-06-22

---

## 1. The design bet

We are betting that a hybrid interface—handwritten particulars combined with typed numeric inputs—solves the ultimate pain point of high-velocity custom checkouts. If we force users to type long descriptions, the UI becomes rigid; if we force them to calculate math, they make errors. By making the Particulars column an ink canvas and the Qty/Price columns clean numeric text fields, we create a layout that looks like a paper slip but performs like a POS calculator.

## 2. The defining interaction

The Hybrid Calculation Loop:
> "The user places their stylus in the Particulars field of Row 1 and handwrites '10m Copper Tube'. They tap the Qty box, enter '3', tap the Price box, and enter '15.50'. Instantly, the Amount field of Row 1 displays '$46.50' in a blue, typewriter-style typeface. Simultaneously, the Total box at the bottom updates to '$46.50'. When the user taps the next row and starts drawing, the active focus shifts naturally."

## 3. Screen inventory

- **Main Workspace Screen** — Split view. Left side: collapsible ledger history sidebar. Right/Center: active yellow paper voucher containing the interactive form table (8 rows of drawing canvas + numeric fields) and top-floating drawing toolbar (Pencil, Eraser, Clear controls).
- **Voucher Detail Modal** — An overlay showing a previously saved voucher slip with its calculated numbers rendered permanently as text overlaying the canvas, options to download PNG, and options to void the slip.

---

## 4. Screen-by-screen specs

### Main Workspace Screen

**Purpose:** Write item descriptions, input quantities and prices, choose payment options, and save the voucher.

**Layout (Left-to-Right split view):**
1. **Collapsible History Sidebar (30% width):**
   - Search bar (queries voucher ID, date, or payment method).
   - Saved Voucher Cards: Displays voucher number (e.g. `#V-0001`), payment method, date, calculated total, and a drawing thumbnail.
2. **Voucher Workspace (70% width):**
   - **Floating Drawing Toolbar (Top):**
     - Color picker buttons (Blue, Black, Red ink).
     - Tool select segmented controls: **Pencil** / **Eraser**.
     - Brush size range slider (1px - 8px).
     - Global actions: **Clear Particulars** (clears all 8 row drawing canvases) and **Clear Voucher** (clears drawing canvases + resets Qty, Price, and Total inputs).
   - **Voucher Paper Sheet (Center):**
     - *Header Block:* Pre-printed title "PAYMENT VOUCHER". Voucher number is auto-filled. Date picker (styled to look like a dotted line field `Date: [ yyyy-mm-dd ]`).
     - *Interactive Receipt Grid:*
       - 8 rows.
       - **Particulars Column:** Contains a transparent canvas over a lined background. Supports touch/stylus drawing. A small trashcan icon appears on hover/touch at the right edge of each row's particulars canvas to clear just that specific row's handwriting.
       - **Qty Column:** A narrow numeric input field.
       - **Price Column:** A narrow numeric input field (supports decimals).
       - **Amount Column:** Auto-calculates `Qty × Price` and displays the result.
     - *Footer Block:*
       - **Authorized Signature** canvas (for signing/approving).
       - **Total Amount** box showing the auto-calculated grand total of all rows.

**Key interactions:**
- **Draw on Row Canvas** → Renders smooth strokes in the chosen ink color or erases if the Eraser tool is active.
- **Edit Qty/Price Inputs** → Triggers real-time change events. Row amount is updated immediately, and the grand total is updated.
- **Toggle Pencil/Eraser** → Switches the drawing canvas mode (Pencil = normal strokes; Eraser = clear/remove stroke pixels).
- **Tap Save Slip** → Triggers paper-rip animation, saves metadata and merged canvas image to IndexedDB, and slides in a fresh sheet.

**States:**
- **Default:** Clean yellow paper voucher with next sequential ID, current date preselected in the date picker, all inputs empty, and total at `$0.00`.
- **Active Drawing:** Stylus captures drawing paths inside specific row boundaries. Non-active canvases remain idle.
- **Row Hover/Active:** Highlighted background on the active row to guide the user's eye across the Particulars, Qty, and Price fields.

---

### Voucher Detail Modal

**Purpose:** View a full, high-resolution rendering of a saved handwritten voucher.

**Layout:**
- High-res PNG image of the completed voucher (combining template, drawing strokes, entered numbers, date, and signature).
- Void Stamp overlay (renders a large red diagonal "VOID" stamp across the voucher if voided).
- Footer options: "Download PNG", "Void Voucher", "Close".

---

## 5. The user journey

**Customer Checkout:**
A contractor purchases 5 pieces of structural wood and 2 boxes of screws. The clerk opens InkVoucher. The date picker is auto-filled with today's date.
1. The clerk handwrites "2x4 10ft Fir Lumber" in the Particulars field of Row 1 using their stylus.
2. They tap Qty and enter `5`. They tap Price and enter `12.00`. The Row 1 Amount displays `$60.00`.
3. They handwrite "3" Wood Screws (100pc Box)" in Row 2.
4. They enter Qty `2` and Price `8.50`. Row 2 Amount displays `$17.00`.
5. The Grand Total updates to `$77.00` in real-time.
6. The customer signs the signature block at the bottom of the page.
7. The clerk selects **PayNow** (payment method), and taps **Save Slip**.
8. A tear sound plays, the sheet slides off, and a blank page slides in.

---

## 6. Component & visual notes

- **Input Styling:** The Qty, Price, and Date inputs are borderless, transparent background elements with a simple dotted bottom border. When focused, they show a subtle amber glow. The text matches the vintage Courier font.
- **Calculations Text:** Auto-calculated amounts are rendered in a slightly faded blue typewriter font to look like they were typed or stamped onto the page, separating them from the clerk's handwriting.
- **Colors:** Slate dark background (`#0b0f19`) to keep contrast high. Voucher is warm paper yellow (`#fef9c3`). Eraser state is indicated by an amber highlight on the tool bar.

## 7. Accessibility & inclusion

- **Screen readers:** Announcements are generated for saved records: *"Saved Voucher V-0001, Total: $77.00, Payment: PayNow."*
- **Inputs:** Keyboard tab navigation lets clerks jump between Qty and Price fields easily.

## 8. What we are NOT designing

- No item database or drop-down suggestions (clerk writes item names manually).
- No currency conversion or unit selection (standardized on numeric inputs).

## 9. Open design questions

- [ ] **Individual Canvas Clear:** Should the per-row clear button be visible at all times, or only on hover/focus? (Always visible as a faint gray trashcan icon next to the canvas to keep interactions discoverable on tablets).

## 10. Handoff to engineering

- The app has 9 separate drawing canvases: 8 for Particulars rows and 1 for the Authorized Signature.
- All canvas stroke points must be captured relative to their individual canvas bounding boxes.
- On save, all 9 canvases must be rendered at their correct coordinates onto the main export canvas, along with the text values from the inputs, the date, and the voucher number.
