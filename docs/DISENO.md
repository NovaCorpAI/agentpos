# Sistema de diseño de AgentPOS

Fecha: 2026-09-20. Origen: revisión del founder tras recorrer el producto publicado.
Diagnóstico: las cuatro superficies se ven idénticas (mismo azul oscuro, misma tarjeta, mismo
botón), frías y monótonas, cuando cada una acompaña un momento emocional distinto. Este
documento define lo compartido y, sobre todo, lo que debe diferenciarse.

## La regla

Una sola marca, cuatro temperamentos. Comparten familia tipográfica, escala de espaciado,
componentes y reglas de accesibilidad. Se diferencian en color de acento, densidad, ritmo
visual, movimiento y voz. Alguien que pasa de una a otra debe reconocer la marca y, al mismo
tiempo, sentir que cambió de lugar.

## Lo compartido (no se toca)

- **Marca**: AGENTPOS en texto, con POS en el acento de la superficie. Nunca un logo de imagen.
- **Tipografía**: "Segoe UI", system-ui, sans-serif. Monoespaciada solo para hashes,
  direcciones de wallet y comandos.
- **Escala**: 4, 8, 12, 16, 24, 32, 48, 64. Radio 6 px en controles, 10 px en tarjetas.
- **Accesibilidad**: contraste mínimo AA (4.5:1 en texto normal, 3:1 en texto grande y en
  bordes de controles); foco visible siempre; nada depende solo del color; objetivos táctiles
  de 44 px. El movimiento respeta `prefers-reduced-motion`.
- **Español con acentos correctos.** "Contraseña", "máquina", "dueño". Sin guiones largos y
  sin emojis. Un producto que escribe mal el español pierde autoridad antes de la primera
  pantalla.
- **Cero imágenes de stock.** Lo visual se construye con SVG inline, degradados y tipografía.

## Los cuatro temperamentos

### 1. Landing (agentposhq.com): invitación

Emoción: curiosidad y credibilidad. Es la única superficie que le habla a alguien que no nos
conoce, y hoy es un muro oscuro parejo.

- **Ritmo alternado**: secciones oscuras y secciones claras (fondo `#f6f8fd`, texto `#0b1020`).
  El contraste entre bloques es lo que rompe la monotonía; el acento sigue siendo `#7aa2ff`.
- **Héroe con movimiento**: el diagrama agente -> x402 -> tienda se anima al entrar (trazo que
  avanza), una sola vez, y queda quieto. Con `prefers-reduced-motion` aparece dibujado.
- **Prueba visible**: la compra real en mainnet como pieza destacada, con el hash en
  monoespaciada, no como una línea más de tabla.
- **Las tres ofertas** no son tres tarjetas iguales: cada una adopta el acento de su superficie
  (ámbar para comercios, teal para el panel, violeta para compradores), de modo que la landing
  enseña el código de color antes de que la persona llegue a cada lugar.

### 2. Instalador (conecta.agentposhq.com): transformación

Emoción: impulso y logro. La persona está convirtiendo su tienda en algo nuevo, y hoy la
pantalla se siente como un formulario de trámite.

- **Acento ámbar** `#f2a33c` (energía, "encender"), sobre la base oscura de la marca.
- **Progreso real**: la barra de pasos es una línea que se llena, no cuatro cajas iguales. El
  paso hecho queda marcado con un check verde y su resumen en una línea ("mitienda.cl,
  WooCommerce"), y se puede volver a él.
- **Antes y después** en el encabezado: dos estados de una misma tienda, uno apagado y otro
  iluminado, en SVG. Es la promesa del producto en una imagen.
- **Cierre con celebración sobria**: el paso 4 no es "aquí tienes archivos", es "tu tienda ya
  vende a agentes", con la llave presentada como un certificado (borde ámbar, monoespaciada,
  botón de copiar) y los tres enlaces siguientes.
- **Voz**: segunda persona, verbos de acción, frases cortas. "Conectemos tu tienda", "Listo,
  ya puede vender".

### 3. Panel del comercio (app.agentposhq.com): control y calma

Emoción: tranquilidad y dominio. Alguien revisa su negocio; no queremos emoción, queremos
legibilidad y confianza.

- **Acento teal** `#2bb3a3` para datos y estados sanos; el azul de marca queda para enlaces y
  acciones secundarias. Rojo solo para lo que exige acción.
- **Densidad mayor**: tipografía un punto menor, tablas con filas compactas, números grandes
  alineados a la derecha, monoespaciada en montos para que las columnas cuadren.
- **Jerarquía de un vistazo**: primero el estado (todo bien / algo requiere atención), después
  las cifras, al final el detalle. Hoy todo pesa lo mismo.
- **Sin sobresaltos**: nada parpadea ni se mueve salvo el indicador de carga.
- **Voz**: informativa y precisa. "3 órdenes esperando pago", no "¡Tienes órdenes!".

### 4. Espacio del comprador (agente.agentposhq.com): poder con límites

Emoción: mando y seguridad. Aquí se define cuánto puede gastar un agente y se aprueban pagos.
Debe sentirse como una sala de control personal, no como un sitio administrativo más.

- **Acento violeta** `#9a7cf5` para lo agéntico; verde `#26d0a0` solo para dinero y hechos
  consumados; ámbar para lo que espera decisión humana; rojo para bloqueos del mandato.
- **El mandato como pieza central**: no es un formulario más, es una tarjeta con aspecto de
  contrato (borde marcado, sello de "vigente", límites en grande y barra de consumo del
  período).
- **Las decisiones pesan**: aprobar y rechazar son botones grandes, separados, con el monto y
  la tienda repetidos en el botón, y confirmación con contraseña. El botón destructivo nunca
  queda junto al de aprobar.
- **Estados con temperatura**: esperando tu decisión (ámbar), esperando firma (violeta),
  pagada (verde), rechazada o fallida (rojo apagado, nunca alarmista).
- **Voz**: directa y en primera persona del dueño. "Tú apruebas", "tu llave nunca sale de tu
  máquina".

## Componentes compartidos (misma estructura, distinto acento)

Encabezado con marca y nombre de superficie; tira de garantías (tres promesas cortas); tarjeta;
campo con etiqueta, ayuda y error; botón primario, secundario y de texto; aviso (información,
éxito, atención, error); estado vacío con siguiente paso; tabla de datos; etiqueta de estado.

Cada superficie los recibe con su acento y su densidad. Nadie inventa un componente nuevo sin
agregarlo aquí.

## Qué NO hacer

- Cambiar el tono de voz a publicitario ("¡revoluciona tu negocio!"): la credibilidad es el
  activo.
- Animaciones decorativas en superficies que mueven dinero.
- Colores de acento distintos dentro de una misma superficie.
- Texto en inglés en superficies en español (hoy quedan restos en los mensajes de verificación).
