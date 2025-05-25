// const lista = require("./lista.json");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { DOMParser } = new JSDOM().window;

function scrapeTariffData(htmlString, daysInMonth) {
  // Create a DOM parser to work with the HTML
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");

  const result = {};

  // Get all row divs that contain h4 elements (section headers)
  const sectionHeaders = doc.querySelectorAll("div.row div.bg-info h4");

  sectionHeaders.forEach((header) => {
    let sectionName = header.textContent.trim();
    const sectionDiv = header.closest("div.row");

    // Find all tables that come after this section header
    let nextElement = sectionDiv.nextElementSibling;
    const tables = [];

    // Collect all tables until we hit another section or end
    while (nextElement) {
      if (nextElement.tagName === "TABLE") {
        tables.push(nextElement);
        nextElement = nextElement.nextElementSibling;
        // Skip <br> tags
        while (nextElement && nextElement.tagName === "BR") {
          nextElement = nextElement.nextElementSibling;
        }
      } else if (
        nextElement.classList &&
        nextElement.classList.contains("row")
      ) {
        // Hit another section, stop collecting tables
        break;
      } else {
        nextElement = nextElement.nextElementSibling;
      }
    }

    // Process tables for this section
    const sectionData = [];

    tables.forEach((table) => {
      const rows = table.querySelectorAll("tr");
      if (rows.length < 2) return; // Skip tables without data rows

      // Get header row
      const headerRow = rows[0];
      const headerCells = headerRow.querySelectorAll("td");

      if (headerCells.length < 3) return; // Skip malformed tables

      const tableData = {
        categoria: headerCells[0].textContent.trim(),
        edenor: {},
        edesur: {},
      };

      // Process data rows
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const cells = row.querySelectorAll("td");

        if (cells.length >= 4) {
          const concept = cells[0].textContent.trim();
          const unidad = cells[1].textContent.trim();
          const edenorValue = cleanValue(cells[2].textContent.trim());
          const edesurValue = cleanValue(cells[3].textContent.trim());

          // Handle tiered pricing (hasta N and excedente a N)
          let conceptKey = concept
            .toLowerCase()
            .replace(/\s+/g, "_")
            .replace(/[^\w]/g, "_")
            .replace(/_+/g, "_")
            .replace(/^_|_$/g, "");

          // Check if this is a tiered rate
          const hastaMatch = concept.match(/hasta\s+(\d+)/i);
          const excedenteMatch = concept.match(/excedente\s+a\s+(\d+)/i);
          // Check if fixed rate has range "cargo_fijo_N_N"
          const fixedRateMatch = conceptKey.match(/cargo_fijo_(\w+)/i);
          const variableRateMatch = conceptKey.match(/cargo_variable_(\w+)/i);
          if (
            fixedRateMatch ||
            (variableRateMatch && !hastaMatch && !excedenteMatch)
          ) {
            // This is a fixed rate with a range
            const rango = fixedRateMatch
              ? fixedRateMatch[1].split("_")
              : variableRateMatch[1].split("_");
            conceptKey = fixedRateMatch ? `cargo_fijo` : `cargo_variable`;
            tableData.edenor[conceptKey] = {
              valor: edenorValue,
              unidad,
              rango,
            };
            tableData.edesur[conceptKey] = {
              valor: edesurValue,
              unidad,
              rango,
            };
          } else if (hastaMatch || excedenteMatch) {
            // This is a tiered rate, structure it differently
            const baseConceptName = concept
              .replace(/\s+(hasta|excedente\s+a)\s+\d+/i, "")
              .trim();
            const baseConcept = baseConceptName
              .toLowerCase()
              .replace(/\s+/g, "_")
              .replace(/[^\w]/g, "_")
              .replace(/_+/g, "_")
              .replace(/^_|_$/g, "");

            // Initialize tiered structure if it doesn't exist
            if (!tableData.edenor[baseConcept]) {
              tableData.edenor[baseConcept] = {};
            }
            if (!tableData.edesur[baseConcept]) {
              tableData.edesur[baseConcept] = {};
            }

            if (hastaMatch) {
              const limit = parseInt(hastaMatch[1]);
              tableData.edenor[baseConcept][`piso`] = {
                limite: limit,
                valor: edenorValue,
                unidad,
              };
              tableData.edesur[baseConcept][`piso`] = {
                limite: limit,
                valor: edesurValue,
                unidad,
              };
            } else if (excedenteMatch) {
              tableData.edenor[baseConcept][`excedente`] = {
                valor: edenorValue,
                unidad,
              };
              tableData.edesur[baseConcept][`excedente`] = {
                valor: edesurValue,
                unidad,
              };
            }
          } else {
            // Regular single-rate concept
            tableData.edenor[conceptKey] = {
              valor: edenorValue,
              unidad,
            };

            tableData.edesur[conceptKey] = {
              valor: edesurValue,
              unidad,
            };
          }
        }
      }
      // Calculate valor_final for provider
      // fixed: {valor: number}
      // variable: { piso: {valor: number}, excedente: {valor: number} }
      const calculateValorFinal = (proveedor) => {
        let valor_final = {};
        let cargo_fijo = proveedor.cargo_fijo || { valor: 0 };
        valor_final.cargo_fijo_dia = (cargo_fijo.valor / daysInMonth) * 1.21;

        if (proveedor.cargo_variable) {
          let cargo_variable = proveedor.cargo_variable;
          let piso = cargo_variable.piso?.valor || cargo_variable.valor || 0;
          valor_final.piso = piso * 1.21;
          if (cargo_variable.excedente) {
            let excedente = cargo_variable.excedente?.valor || 0;
            valor_final.excedente = excedente * 1.21;
          }
        }
        return valor_final;
      };
      tableData.edenor["valor_final"] = calculateValorFinal(tableData.edenor);
      tableData.edesur["valor_final"] = calculateValorFinal(tableData.edesur);

      sectionData.push(tableData);
    });

    // if the section name matches "Tarifa N - R Nivel N"
    // then we need to change the name to "T1R2"
    const regex = /Tarifa\s+(\w+)\s+-\s+R\s+Nivel\s+(\d+)/i;
    const match = sectionName.match(regex);
    if (match) {
      const tarifa = match[1].toUpperCase();
      const nivel = match[2];
      sectionName = `T${tarifa}R${nivel}`;
    }

    // Clean section name for use as object key
    const sectionKey = sectionName
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^\w]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");

    result[sectionKey] = {
      nombre: sectionName,
      categorias: sectionData,
    };
  });

  return result;
}

// Clean and convert values
function cleanValue(value) {
  if (!value || value === "" || value === " ") return null;
  // Remove font tags and extra whitespace
  const cleaned = value
    .replace(/<[^>]*>/g, "")
    .trim()
    .replace(",", "");
  // Try to convert to number if it looks like a number
  const num = parseFloat(cleaned);
  return isNaN(num) ? cleaned : num;
}

// If running in browser context
if (typeof window !== "undefined" && window.document) {
  // You can call this function to scrape the current page
  window.scrapeTariffData = () => {
    const result = scrapeTariffData(document.documentElement.outerHTML);
    console.log("Scraped data:", result);
    return result;
  };
}

function extractCSVFromJSONCategoryProvider(
  data,
  date,
  tarif,
  category,
  provider
) {
  const result = [];
  const provider_data = data[tarif.toLowerCase()]?.categorias?.find(
    (value) => value.categoria === category
  )?.[provider];
  result.push(date);
  result.push(provider_data.cargo_fijo.valor);
  result.push(provider_data.valor_final.cargo_fijo_dia);
  if (provider_data.cargo_variable) {
    if (!provider_data.cargo_variable.piso) {
      result.push(provider_data.cargo_variable.valor);
      result.push(null);
    } else {
      result.push(provider_data.cargo_variable.piso.valor);
      result.push(provider_data.valor_final.piso);
    }
    if (provider_data.cargo_variable.excedente) {
      result.push(provider_data.cargo_variable.piso.limite);
      result.push(provider_data.cargo_variable.excedente.valor);
      result.push(provider_data.valor_final.excedente);
    } else {
      result.push(null);
      result.push(null);
      result.push(null);
    }
  } else {
    result.push(null);
    result.push(null);
    result.push(null);
    result.push(null);
    result.push(null);
  }

  return result;
}

(async () => {
  const baseUrl = "https://www.enre.gov.ar/web/TARIFASD.nsf/";
  const baseResponse = await fetch(
    baseUrl + "todoscuadros?OpenView&collapseview"
  );
  const baseHtmlString = await baseResponse.text();
  const baseDoc = new DOMParser().parseFromString(baseHtmlString, "text/html");
  const lista = [];
  baseDoc
    .querySelectorAll("td a")
    .forEach((e) =>
      lista.push([
        e.text.split(" ").pop(),
        baseUrl + e.href.toLowerCase().replace("/web\\tarifasd.nsf/", ""),
      ])
    );

  if (lista.length > 0) {
    for (let i = 0; i < lista.length; i++) {
      // item[0] is a date in format MM-YYYY
      const item = lista[i];
      const filePath = path.join(__dirname, "tarifas", `${item[0]}.json`);
      const provider = "edesur";
      const providerCsvPath = path.join(
        __dirname,
        "tarifas",
        `${provider}.csv`
      );

      if (!fs.existsSync(filePath)) {
        try {
          const daysInMonth = new Date(
            parseInt(item[0].split("-")[1]),
            parseInt(item[0].split("-")[0]),
            0
          ).getDate();
          const response = await fetch(item[1]);
          const htmlString = await response.text();
          const result = scrapeTariffData(htmlString, daysInMonth);
          const csvResult = extractCSVFromJSONCategoryProvider(
            result,
            item[0],
            "T1R2",
            "R2",
            provider
          );
          // write a separated csv file without headers with the first item as this is the latest
          if (i === 0) {
            const jsonResult = {
              fecha: csvResult[0],
              cargo_fijo: csvResult[1],
              cargo_fijo_final_dia: csvResult[2],
              piso: csvResult[3],
              piso_final: csvResult[4],
              piso_limite: csvResult[5],
              excedente: csvResult[6],
              excedente_final: csvResult[7],
            };
            fs.writeFileSync(
              path.join(__dirname, "tarifas", `${provider}_latest.json`),
              JSON.stringify(jsonResult, null, 2)
            );
          }
          if (!fs.existsSync(providerCsvPath)) {
            fs.writeFileSync(
              providerCsvPath,
              "fecha,cargo_fijo,cargo_fijo_final_dia,piso,piso_final,piso_limite,excedente,excedente_final\n"
            );
          }
          fs.appendFileSync(
            providerCsvPath,
            csvResult.join(",") + "\n",
            "utf8"
          );
          fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
          console.log(`Data saved to ${filePath}`);
        } catch (error) {
          console.error("Error fetching data:", error);
        }
      }
    }
  }
})();
