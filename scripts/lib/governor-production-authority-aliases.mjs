import path from "node:path";
import ts from "typescript";

function resolveTarget(fromFile, specifier, fileSet) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  for (const candidate of [joined, `${joined}.js`, `${joined}/index.js`]) {
    if (fileSet.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function localBindingCarriesAuthority(
  file,
  localName,
  parsed,
  fileSet,
  authorityExportNames,
  visited = new Set(),
) {
  const visitKey = `${file}:${localName}`;
  if (visited.has(visitKey)) {
    return false;
  }
  const nextVisited = new Set(visited).add(visitKey);
  const info = parsed.get(file);
  for (const binding of info?.importBindings ?? []) {
    if (binding.local !== localName) {
      continue;
    }
    const target = resolveTarget(file, binding.specifier, fileSet);
    if (!target) {
      continue;
    }
    if (binding.namespace) {
      return (authorityExportNames.get(target)?.size ?? 0) > 0;
    }
    if (authorityExportNames.get(target)?.has(binding.imported)) {
      return true;
    }
  }
  const initializer = info?.topLevelInitializers.get(localName);
  if (initializer) {
    return expressionCarriesAuthority(
      file,
      initializer,
      parsed,
      fileSet,
      authorityExportNames,
      nextVisited,
    );
  }
  const origin = info?.topLevelBindingOrigins.get(localName);
  return origin
    ? selectedExpressionCarriesAuthority(
        file,
        origin.expression,
        origin.selectors,
        parsed,
        fileSet,
        authorityExportNames,
        nextVisited,
      ) ||
        origin.defaults.some((expression) =>
          expressionCarriesAuthority(
            file,
            expression,
            parsed,
            fileSet,
            authorityExportNames,
            nextVisited,
          ),
        )
    : false;
}

function propertyNameText(name) {
  return name &&
    (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
    ? name.text
    : undefined;
}

function elementAccessSelector(expression) {
  const argument = expression.argumentExpression;
  return argument && (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument))
    ? argument.text
    : undefined;
}

function selectedExpressionCarriesAuthority(
  file,
  expression,
  selectors,
  parsed,
  fileSet,
  authorityExportNames,
  visited,
) {
  if (selectors.length === 0) {
    return expressionCarriesAuthority(
      file,
      expression,
      parsed,
      fileSet,
      authorityExportNames,
      visited,
    );
  }
  const [selector, ...rest] = selectors;
  if (ts.isParenthesizedExpression(expression)) {
    return selectedExpressionCarriesAuthority(
      file,
      expression.expression,
      selectors,
      parsed,
      fileSet,
      authorityExportNames,
      visited,
    );
  }
  if (ts.isIdentifier(expression)) {
    const info = parsed.get(file);
    const namespaceBinding = info?.importBindings.find(
      (binding) => binding.local === expression.text && binding.namespace,
    );
    if (namespaceBinding && typeof selector === "string") {
      const target = resolveTarget(file, namespaceBinding.specifier, fileSet);
      return Boolean(target && authorityExportNames.get(target)?.has(selector));
    }
    const initializer = info?.topLevelInitializers.get(expression.text);
    if (initializer) {
      const visitKey = `${file}:${expression.text}#selected`;
      if (visited.has(visitKey)) {
        return false;
      }
      return selectedExpressionCarriesAuthority(
        file,
        initializer,
        selectors,
        parsed,
        fileSet,
        authorityExportNames,
        new Set(visited).add(visitKey),
      );
    }
  }
  if (ts.isArrayLiteralExpression(expression) && typeof selector === "number") {
    const selected = expression.elements[selector];
    return Boolean(
      selected &&
      !ts.isOmittedExpression(selected) &&
      selectedExpressionCarriesAuthority(
        file,
        ts.isSpreadElement(selected) ? selected.expression : selected,
        rest,
        parsed,
        fileSet,
        authorityExportNames,
        visited,
      ),
    );
  }
  if (ts.isObjectLiteralExpression(expression) && typeof selector === "string") {
    for (const property of expression.properties) {
      if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === selector) {
        return selectedExpressionCarriesAuthority(
          file,
          property.initializer,
          rest,
          parsed,
          fileSet,
          authorityExportNames,
          visited,
        );
      }
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === selector) {
        return selectedExpressionCarriesAuthority(
          file,
          property.name,
          rest,
          parsed,
          fileSet,
          authorityExportNames,
          visited,
        );
      }
    }
  }
  return expressionCarriesAuthority(
    file,
    expression,
    parsed,
    fileSet,
    authorityExportNames,
    visited,
  );
}

function expressionCarriesAuthority(
  file,
  expression,
  parsed,
  fileSet,
  authorityExportNames,
  visited,
) {
  if (ts.isParenthesizedExpression(expression)) {
    return expressionCarriesAuthority(
      file,
      expression.expression,
      parsed,
      fileSet,
      authorityExportNames,
      visited,
    );
  }
  if (ts.isIdentifier(expression)) {
    return localBindingCarriesAuthority(
      file,
      expression.text,
      parsed,
      fileSet,
      authorityExportNames,
      visited,
    );
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expressionCarriesAuthority(
      file,
      expression.expression,
      parsed,
      fileSet,
      authorityExportNames,
      visited,
    );
  }
  if (ts.isElementAccessExpression(expression)) {
    const selector = elementAccessSelector(expression);
    return (
      selector !== undefined &&
      selectedExpressionCarriesAuthority(
        file,
        expression.expression,
        [selector],
        parsed,
        fileSet,
        authorityExportNames,
        visited,
      )
    );
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.some(
      (element) =>
        !ts.isOmittedExpression(element) &&
        expressionCarriesAuthority(
          file,
          ts.isSpreadElement(element) ? element.expression : element,
          parsed,
          fileSet,
          authorityExportNames,
          visited,
        ),
    );
  }
  if (!ts.isObjectLiteralExpression(expression)) {
    return false;
  }
  return expression.properties.some((property) => {
    if (ts.isSpreadAssignment(property)) {
      return expressionCarriesAuthority(
        file,
        property.expression,
        parsed,
        fileSet,
        authorityExportNames,
        visited,
      );
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      return localBindingCarriesAuthority(
        file,
        property.name.text,
        parsed,
        fileSet,
        authorityExportNames,
        visited,
      );
    }
    return (
      ts.isPropertyAssignment(property) &&
      expressionCarriesAuthority(
        file,
        property.initializer,
        parsed,
        fileSet,
        authorityExportNames,
        visited,
      )
    );
  });
}

export function propagateLocalAuthorityAliases({ parsed, fileSet, authorityExportNames }) {
  let changed = false;
  for (const [file, info] of parsed) {
    for (const localExport of info.localExports) {
      if (
        localBindingCarriesAuthority(
          file,
          localExport.local,
          parsed,
          fileSet,
          authorityExportNames,
        ) &&
        !authorityExportNames.get(file).has(localExport.exported)
      ) {
        authorityExportNames.get(file).add(localExport.exported);
        changed = true;
      }
    }
    for (const expressionExport of info.expressionExports) {
      if (
        expressionCarriesAuthority(
          file,
          expressionExport.expression,
          parsed,
          fileSet,
          authorityExportNames,
          new Set(),
        ) &&
        !authorityExportNames.get(file).has(expressionExport.exported)
      ) {
        authorityExportNames.get(file).add(expressionExport.exported);
        changed = true;
      }
    }
  }
  return changed;
}
