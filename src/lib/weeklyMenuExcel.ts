import * as xlsx from 'xlsx';
import { createEmptyMenu, MENU_ROWS, parseWeeklyMenuRows } from '../../agent/lib/weekly-menu.mjs';
import { formatDate } from '../../agent/lib/meal-rules.mjs';
import { isWeekId } from '../../agent/lib/survey.mjs';

export const MAX_MENU_FILE_SIZE = 5 * 1024 * 1024;

/** The same 8 columns and 7 meal rows as the Nutrition team's paper template. */
export function weeklyMenuWorkbook(weekId: string): xlsx.WorkBook {
  if (!isWeekId(weekId)) throw new Error('Vui lòng chọn một tuần hợp lệ.');
  const menu = createEmptyMenu(weekId);
  const rows: (string | number)[][] = [
    ['', '', 'No', 'THỨ 2', 'THỨ 3', 'THỨ 4', 'THỨ 5', 'THỨ 6'],
    ['', '', '', ...menu.days.map(day => formatDate(day.date))],
    ...MENU_ROWS.map((row, index) => [
      index === 0 ? 'ĂN SÁNG' : index === 1 ? 'ĂN TRƯA' : '',
      index === 0 ? '' : row.label.toUpperCase(),
      index === 0 ? 1 : index,
      '', '', '', '', '',
    ]),
    ['', '', '', '', '', '', '', ''],
    ['GHI CHÚ', '', '', '', '', '', '', ''],
  ];
  const sheet = xlsx.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 12 }, { wch: 19 }, { wch: 5 }, ...Array.from({ length: 5 }, () => ({ wch: 30 }))];
  sheet['!rows'] = rows.map((_, index) => ({ hpt: index === 0 ? 25 : index === 1 ? 23 : index === 9 ? 10 : 40 }));
  sheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } },
    { s: { r: 0, c: 1 }, e: { r: 1, c: 1 } },
    { s: { r: 0, c: 2 }, e: { r: 1, c: 2 } },
    { s: { r: 3, c: 0 }, e: { r: 8, c: 0 } },
    { s: { r: 10, c: 0 }, e: { r: 10, c: 2 } },
    { s: { r: 10, c: 3 }, e: { r: 10, c: 7 } },
  ];
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, sheet, 'Thực đơn');
  workbook.Props = { Title: `Thực đơn tuần ${formatDate(weekId)}`, Author: 'Nhóm Dinh dưỡng' };
  return workbook;
}

// SheetJS Community writes values, widths and merges but does not write cell
// colours. Its public CFB ZIP API lets us add a small, fixed OOXML style sheet
// without another browser dependency. Only our generated template is changed.
const TEMPLATE_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4">
<font><sz val="11"/><name val="Times New Roman"/><color rgb="FF111827"/></font>
<font><b/><sz val="11"/><name val="Times New Roman"/><color rgb="FF111827"/></font>
<font><b/><sz val="11"/><name val="Times New Roman"/><color rgb="FF0000FF"/></font>
<font><b/><i/><sz val="11"/><name val="Times New Roman"/><color rgb="FFFF0000"/></font>
</fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFCE5CD"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFCFE2F3"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF333333"/></left><right style="thin"><color rgb="FF333333"/></right><top style="thin"><color rgb="FF333333"/></top><bottom style="thin"><color rgb="FF333333"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export function createWeeklyMenuTemplate(weekId: string): Uint8Array {
  // Browser bundlers use xlsx's ESM export; Node exposes CFB on its CJS default.
  const cfb = xlsx.CFB ?? Reflect.get(xlsx, 'default')?.CFB;
  const archive = cfb.read(new Uint8Array(xlsx.write(weeklyMenuWorkbook(weekId), { bookType: 'xlsx', type: 'array' })), { type: 'array' });
  const entry = cfb.find(archive, '/xl/worksheets/sheet1.xml');
  if (!entry) throw new Error('Không tạo được mẫu Excel.');
  let sheetXml = new TextDecoder().decode(new Uint8Array(entry.content));
  sheetXml = sheetXml.replace(/<c\b([^>]*\br="([A-H])(\d+)"[^>]*)>/g, (_, attrs: string, column: string, rawRow: string) => {
    const row = Number(rawRow);
    const style = row <= 2 ? 1 : row === 3 ? (column === 'A' ? 3 : 2) : row <= 9 ? (column === 'A' ? 3 : column === 'B' ? 4 : column === 'C' ? 6 : 5) : row === 11 ? (column <= 'C' ? 1 : 5) : 0;
    return `<c${attrs.replace(/\s+s="\d+"/g, '')} s="${style}">`;
  });
  sheetXml = sheetXml.replace('<dimension', '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension');
  sheetXml = sheetXml.replace('<sheetView workbookViewId="0"/>', '<sheetView workbookViewId="0"><pane xSplit="3" ySplit="2" topLeftCell="D3" activePane="bottomRight" state="frozen"/></sheetView>');
  const printSettings = '<printOptions horizontalCentered="1"/><pageMargins left="0.25" right="0.25" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="1"/>';
  // OOXML orders page settings before ignoredErrors. Keeping that order avoids
  // Excel repairing a generated worksheet when it opens the template.
  sheetXml = sheetXml.includes('<ignoredErrors>') ? sheetXml.replace('<ignoredErrors>', `${printSettings}<ignoredErrors>`) : sheetXml.replace('</worksheet>', `${printSettings}</worksheet>`);
  cfb.utils.cfb_add(archive, '/xl/worksheets/sheet1.xml', new TextEncoder().encode(sheetXml));
  cfb.utils.cfb_add(archive, '/xl/styles.xml', new TextEncoder().encode(TEMPLATE_STYLES));
  return new Uint8Array(cfb.write(archive, { fileType: 'zip', type: 'array', compression: true }));
}

export function downloadWeeklyMenuTemplate(weekId: string) {
  const bytes = createWeeklyMenuTemplate(weekId);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `Mau-thuc-don-${weekId}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readWeeklyMenuWorkbook(file: File): Promise<xlsx.WorkBook> {
  if (!/\.(xlsx|xls)$/i.test(file.name)) throw new Error('Vui lòng chọn file Excel .xlsx hoặc .xls.');
  if (!file.size) throw new Error('File Excel đang trống.');
  if (file.size > MAX_MENU_FILE_SIZE) throw new Error('File Excel không được lớn hơn 5 MB.');
  try {
    const workbook = xlsx.read(await file.arrayBuffer(), { type: 'array', cellDates: false, sheetRows: 501 });
    if (!workbook.SheetNames.length) throw new Error('Không tìm thấy trang tính trong file Excel.');
    return workbook;
  } catch (error) {
    if (error instanceof Error && error.message === 'Không tìm thấy trang tính trong file Excel.') throw error;
    throw new Error('Không đọc được file Excel. Hãy kiểm tra file có bị lỗi hoặc được đặt mật khẩu không.');
  }
}

export function importWeeklyMenuSheet(workbook: xlsx.WorkBook, sheetName: string, weekId: string) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error('Không tìm thấy trang tính đã chọn.');
  const range = xlsx.utils.decode_range(sheet['!fullref'] ?? sheet['!ref'] ?? 'A1');
  if (range.e.r >= 500 || range.e.c >= 50) throw new Error('Trang tính thực đơn tối đa 500 hàng và 50 cột. Vui lòng dùng file mẫu.');
  const rows = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' });
  return parseWeeklyMenuRows(rows, weekId, { date1904: workbook.Workbook?.WBProps?.date1904 === true });
}
