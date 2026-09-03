# SPEC 03: Fiscal como plugin (`@agentpos/fiscal`)

## Posición

Cobrar a agentes en stablecoin debe poder ser un ingreso ORDENADO en la
contabilidad del vendedor, en cualquier país. Pero la fiscalidad es local y
NO está en el camino crítico v1. Este paquete define la interfaz y entrega
un plugin de ejemplo; los plugins por país son fase Build o comunidad.

## Interfaz en core (`packages/core/src/fiscal.ts`)

```
interface FiscalAdapter {
  country: string            // ISO 3166-1 alpha-2
  currency: string           // ISO 4217
  valorize(payment): Promise<{ rate, localValue, source, ts }>
  summarize(range): Promise<Summary>      // ingresos locales, n órdenes
  export(range, format: 'csv' | 'json'): Promise<Buffer>
}
```

Registro por config: `fiscal: { adapter: 'example-usd' | '<plugin>' }`.
Sin adapter configurado, el dashboard muestra solo USDC.

## Plugin de ejemplo v1 (`fiscal/adapters/example`)

- Valorización por pago a una moneda local usando proveedor de tipo de
  cambio configurable (primario + fallback; guarda fuente y rate).
- Resumen mensual y export CSV con hashes verificables.
- Sirve como plantilla documentada para plugins de terceros.

## Explicitamente fuera de v1

Emisión de comprobantes/facturas electrónicas por API, impuestos por tipo
de contribuyente, calce de conversiones, integraciones con autoridades
fiscales de ningún país. Cualquier plugin por país (CL, AR, MX, EU...)
entra en Build o como contribución externa con su propio mantenedor.

## Tests

Contrato de la interfaz (test suite reutilizable que todo plugin debe
pasar). Golden files del export del plugin de ejemplo.
