# Guía del partner: instalar AgentPOS en la tienda de un cliente

Para agencias, freelancers e integradores que mantienen tiendas de otros. Aquí está lo que
necesitas para dejar una tienda vendiendo a agentes sin que tengamos que estar nosotros, qué
entregarle al comercio y qué reglas no se negocian.

Relacionado: [inicio rápido del vendedor](quickstart-merchant.es.md) ·
[guía asistida paso a paso](onboarding.es.md) · [operación](operations.es.md) ·
[qué es abierto y qué es servicio](open-core.es.md) ·
En inglés: [partners.en.md](partners.en.md)

## Por qué esto existe

Un comercio tiene una tienda. Tú tienes veinte. Eres el único lugar de este mercado donde
instalar una vez vale por muchas, y además llegas con la confianza ya construida: el comercio no
nos conoce, pero a ti te conoce hace años.

## Lo que cobras y lo que cobramos

- **La instalación la cobras tú, al precio que definas.** Nosotros publicamos US$99 como
  referencia; tu mercado es tuyo y no pedimos parte.
- **El servicio operado lo cobramos nosotros**, US$19 al mes por tienda, y tienes dos formas de
  participar: precio de reventa con descuento (le facturas tú al comercio) o comisión recurrente
  por referido, que se paga mientras la tienda siga activa y tú sigas siendo su primera línea
  (le facturamos nosotros y te transferimos en USDC). Los números vigentes están en el correo del programa,
  porque todavía son borrador.
- **Nunca un porcentaje de la venta del comercio**, ni tuyo ni nuestro. La comisión de partner
  sale de nuestra tarifa.

## La instalación certificada, paso a paso

El detalle técnico está en la [guía asistida](onboarding.es.md). Aquí va lo que la convierte en
una instalación _certificada_, que es lo que te pedimos para figurar como partner.

### Antes de la llamada con tu cliente

1. Confirma que la tienda corre **WooCommerce con HTTPS** y que puedes crear una clave REST.
2. Confirma dónde va a correr el sidecar: un proceso Node junto a la tienda, un contenedor, o
   **operado por nosotros** si el hosting es compartido y no admite procesos propios.
3. Pide la **dirección pública** de la billetera Stellar del comercio (`G...` o `C...`). Si no
   tiene, se crea en la llamada, con el comercio al mando.
4. Consigue la **API key del facilitador** para la red que corresponda.

> **Regla que no se negocia:** jamás pidas ni recibas la llave privada del comercio. Si algún
> paso parece necesitarla, algo está mal: detente y escríbenos.

### Durante la llamada (unas dos horas)

- [ ] Sidecar corriendo y respondiendo en el dominio del comercio.
- [ ] Catálogo escaneado y **confirmado por el comercio, artículo por artículo y precio por
      precio**. Esto no lo decides tú: el precio en USDC lo confirma siempre el humano dueño de
      la tienda.
- [ ] Billetera vinculada con prueba de control, solo dirección pública.
- [ ] Regla del proxy publicada, y las rutas nuevas respondiendo (`/.well-known/ucp`,
      `/agentpos/catalog`, `/openapi.json`, `/llms.txt`).
- [ ] **Una compra de prueba real, de punta a punta**, con su hash de transacción y la orden
      visible en el administrador de WooCommerce del comercio.
- [ ] Llave del panel entregada al comercio, y verificado que sin ella nadie lee sus órdenes.

### Lo que le entregas al comercio

1. Un resumen escrito de una página: qué quedó instalado, dónde corre, qué rutas se agregaron y
   cómo se apaga si quiere.
2. El hash de la compra de prueba, para que pueda verla en el explorador él mismo.
3. Quién responde qué: tú para su tienda, nosotros para el producto.

## Mantenerlo funcionando

- El aviso de versión nueva llega al panel. **Mantener al día el AgentPOS de tus comercios es
  parte del trato.**
- Cuando una orden queda trabada, el panel avisa. La [guía de operación](operations.es.md)
  explica cada estado y cómo destrabar.
- Si la falla es nuestra (un error del código o un servicio nuestro caído), la arreglamos gratis
  y sin tope de tiempo, en cualquier plan. Escríbenos y punto.

## Lo que se te exige para ser partner

1. Una instalación real funcionando antes de figurar en la lista de instaladores.
2. Mantener al día el AgentPOS de tus comercios.
3. Nunca pedir una llave privada.
4. Que el comercio sea el dueño de todo: su billetera, sus datos, su cuenta. Si cambia de
   agencia, se lleva la tienda funcionando sin pedirnos permiso ni migrar nada.

## Lo que no puedes hacer con nuestra infraestructura

- Cobrarle al comercio un porcentaje de sus ventas usando AgentPOS. Nuestra tarifa es fija y el
  producto no te da ninguna herramienta para tomar un corte de cada venta.
- Publicar catálogo de un comercio sin su confirmación explícita.
- Retener el acceso de un comercio a su propia tienda o a su propia billetera.

## Cómo entrar

En <https://agentposhq.com/precios#partners> está el formulario: marca **Instalo para otros** y
cuéntanos cuántas tiendas mantienes y en qué plataforma. A los primeros partners los acompañamos
a mano, con la primera instalación hecha en conjunto.
