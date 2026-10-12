# QUBO

> Registra ingresos y decide qué pagar, qué reservar y qué conservar.

QUBO es una aplicación web y PWA ligera e intuitiva diseñada para la gestión financiera personal y el reparto inteligente de ingresos sin requerir servidores complejos ni bases de datos remotas.

## 📁 Estructura del Proyecto

- **`qubo-fuente/`**: Código fuente modular del proyecto.
  - `src/`: Archivos base (HTML, CSS, JS modular, assets y Service Worker).
  - `test/`: Pruebas unitarias y de humo para la lógica central y la interfaz.
  - `build.py`: Script para compilar el código fuente en paquetes independientes.
- **`qubo-hostinger/`**: Versión empaquetada lista para desplegar en hosting estático (ej. Hostinger, Apache, Nginx o GitHub Pages).
  - `index.html`: Aplicación compilada standalone.
  - `sw.js`: Service worker para funcionamiento offline.
  - `manifest.webmanifest`: Manifiesto para instalación como Progressive Web App (PWA).

## 🚀 Despliegue Rápido

1. Sube el contenido de la carpeta `qubo-hostinger/` al directorio web de tu servidor (`public_html` o similar).
2. Asegúrate de contar con certificado SSL activo (HTTPS) para habilitar las funciones offline y PWA.
3. Abre el sitio en tu navegador y disfruta de la aplicación.
