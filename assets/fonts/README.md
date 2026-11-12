Inter (Regular 400, SemiBold 600) by Rasmus Andersson, used by the invoice PDF
for its rupee sign and tabular figures. SIL Open Font License 1.1:
https://github.com/rsms/inter/blob/master/LICENSE.txt

These are slimmed copies: Latin letters, punctuation, currency signs (₹) and
arrows, with only kerning and tabular figures kept. The full font made pdfkit
take about 1.4 s per invoice; these take about 50 ms. To rebuild from Inter's
own .woff or .ttf files (needs `pip install fonttools`):

    pyftsubset Inter-Regular.woff --unicodes="U+0000-024F,U+2000-206F,U+20A0-20CF,U+2190-21FF,U+2212" --layout-features="kern,tnum" --flavor="" --output-file=Inter-Regular.ttf

(the same for SemiBold). lib/invoicePdf.test.ts checks ₹, tabular figures and
the drawing time.
