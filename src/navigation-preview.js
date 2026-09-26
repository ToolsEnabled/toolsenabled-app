import './app-navigation.css'
import { mountAppNavigation } from './app-navigation.js'

// The review page switches the same production navigation for comparison.
export function setNavigationPreview(layout = 'side') {
  document.body.dataset.navigationPreview = layout
  mountAppNavigation().setLayout(layout)
}
