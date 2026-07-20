
import React from 'react';

// Generic crash guard for a panel/section. If a child throws during render,
// this shows a small inline fallback instead of taking down the whole app.
class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }

    componentDidCatch(error, info) {
        console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error, info);
    }

    handleReset = () => {
        this.setState({ hasError: false, error: null });
        if (this.props.onReset) this.props.onReset();
    };

    render() {
        if (this.state.hasError) {
            return (
                <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-4 text-sm text-red-200">
                    <p className="font-semibold mb-1">
                        {this.props.label ? `${this.props.label} ` : ''}crashed and was stopped so the rest of the app keeps working.
                    </p>
                    <p className="text-xs text-red-300/80 mb-2">{String(this.state.error?.message || this.state.error || '')}</p>
                    <button
                        onClick={this.handleReset}
                        className="px-2 py-1 rounded text-xs font-medium bg-red-700 hover:bg-red-600 text-white"
                    >
                        Reload this panel
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

export default ErrorBoundary;
