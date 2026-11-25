// 閲覧の画面（ranking.html）の入口。タスク 027
import { render } from 'preact';
import { ViewerApp } from './ViewerApp.tsx';
import './style.css';

render(<ViewerApp />, document.getElementById('app')!);
