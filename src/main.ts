import { loadAssets } from './assets';
import { Game } from './game/game';

const loadingText = document.getElementById('loading-text')!;
const loadingFill = document.getElementById('loading-fill')!;
const loadingErr = document.getElementById('loading-err')!;

async function boot(): Promise<void> {
  try {
    const assets = await loadAssets((msg, frac) => { loadingText.textContent = msg; loadingFill.style.width = `${Math.round(frac * 100)}%`; });
    loadingText.textContent = 'Starting…';
    const game = new Game(assets, document.getElementById('game') as HTMLCanvasElement, document.getElementById('gui') as HTMLCanvasElement);
    (window as any).game = game;
    await game.start();
    // vanilla LoadingOverlay fades out over about a second once the game is ready
    const loading = document.getElementById('loading')!;
    loading.classList.add('fade');
    setTimeout(() => { loading.style.display = 'none'; }, 1000);
  } catch (e: any) {
    console.error(e);
    loadingErr.textContent = String(e?.stack ?? e);
  }
}
boot();
